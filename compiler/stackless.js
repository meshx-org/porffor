// Stackless async functions (--stackless): an async function whose awaits can all be
// lifted to statement level runs as a step function over a heap frame instead of on a
// coroutine stack. This pass decides which functions qualify and rewrites their bodies so
// every await is a statement of its own: `local = await x` or a bare `await x`. The
// renderer (render.js) turns each of those into a suspension point; the frame holds the
// function's params, locals and the temps made here.
//
// A try in a step keeps no setjmp of its own: the step's wrapper holds the one setjmp and
// re-enters the step at the catch the frame names (render.js), so an await may sit inside
// a try (finally is a catch by then: codegen lowers it). Entering a catch that way loses
// the step's C locals as a resume does, so it counts as a suspension below.
//
// Not yet (the function stays stackful): generators, raw C, or an await in a loop's update.

import { K, T, FX, N_KIND, N_TYPE, N_FX, N_A, N_B, N_C, KNames, Local, Assign, Await, Un, Break } from './ir.js';

const isNode = node => Array.isArray(node) && typeof node[0] === 'number' &&
  KNames[node[0]] !== undefined && node.length === 6;

// whether a node or list holds a node of kind k (memoized: subtrees are shared)
const makeHas = k => {
  const memo = new WeakMap();
  const has = node => {
    if (!Array.isArray(node)) return false;
    const seen = memo.get(node);
    if (seen !== undefined) return seen;
    const found = isNode(node)
      ? node[N_KIND] === k || has(node[N_A]) || has(node[N_B]) || has(node[N_C])
      : node.some(has);
    memo.set(node, found);
    return found;
  };
  return has;
};

export const hasAwait = makeHas(K.Await);
export const hasTry = makeHas(K.Try);
// where a step can be re-entered: at an await's resume, or at a catch
export const hasSuspend = node => hasAwait(node) || hasTry(node);
const hasYield = makeHas(K.Yield);
const hasRawC = makeHas(K.RawC);
const hasContinue = makeHas(K.Continue);

// an await where lifting cannot reach yet
const blocked = node => {
  if (!Array.isArray(node)) return false;
  if (!isNode(node)) return node.some(blocked);
  if (!hasAwait(node)) return false;
  const k = node[N_KIND];
  if (k === K.Loop && hasAwait(node[N_B])) return true;
  return blocked(node[N_A]) || blocked(node[N_B]) || blocked(node[N_C]);
};

// values an await cannot change: safe to leave in place before one
const PURE_KINDS = new Set([ K.Const, K.JvConst, K.DataRef, K.FuncIdx, K.FuncRec ]);

/**
 * The body of `f` with every await lifted to a statement, and the temps that took,
 * or null when `f` is not an async function that can run stackless.
 */
export const planStackless = f => {
  if (!f || !f.async || f.generator || !f.hasAwait || !f.body) return null;
  if (hasYield(f.body) || hasRawC(f.body) || blocked(f.body)) return null;

  const temps = Object.create(null);
  let count = 0;
  const temp = type => {
    const name = `__porf_aw${count++}`;
    temps[name] = type;
    return Local(name, type);
  };
  const isTemp = node => node[N_KIND] === K.Local && node[N_A] in temps;

  // the operand nodes of a node, in evaluation order (slots a, b, c; lists within them)
  const operands = node => {
    const out = [];
    const walk = x => {
      if (!Array.isArray(x)) return;
      if (isNode(x)) out.push(x);
      else for (const y of x) walk(y);
    };
    walk(node[N_A]); walk(node[N_B]); walk(node[N_C]);
    return out;
  };

  // the node with its operands replaced (same shape: lists copied, literals kept)
  const withOperands = (node, replace) => {
    const map = x => {
      if (!Array.isArray(x)) return x;
      if (isNode(x)) return replace.get(x) ?? x;
      return x.map(map);
    };
    return [ node[N_KIND], node[N_TYPE], node[N_FX], map(node[N_A]), map(node[N_B]), map(node[N_C]) ];
  };

  const assignLifted = (target, value) => {
    const out = [];
    const v = liftExpr(value, out);
    out.push(Assign(target, v));
    return out;
  };

  // an expression without awaits in it, their statements pushed to out first
  const liftExpr = (node, out) => {
    if (!hasAwait(node)) return node;
    const k = node[N_KIND];

    if (k === K.Await) {
      const value = liftExpr(node[N_A], out);
      const t = temp(T.jsval);
      out.push(Assign(t, Await(value)));
      return t;
    }

    // lazily evaluated operands: an await in them runs only on their branch
    if (k === K.Select && (hasAwait(node[N_B]) || hasAwait(node[N_C]))) {
      const cond = liftExpr(node[N_A], out);
      const t = temp(node[N_TYPE]);
      out.push([ K.If, T.none, FX.call, cond, assignLifted(t, node[N_B]), assignLifted(t, node[N_C]) ]);
      return t;
    }
    if (k === K.Bin && (node[N_A] === '&&' || node[N_A] === '||') && hasAwait(node[N_C])) {
      const t = temp(T.i32);
      const truth = x => Un('!', T.i32, Un('!', T.i32, x));
      out.push(Assign(t, truth(liftExpr(node[N_B], out))));
      out.push([ K.If, T.none, FX.call, node[N_A] === '&&' ? t : Un('!', T.i32, t),
        assignLifted(t, truth(node[N_C])), null ]);
      return t;
    }

    // everything evaluated before the last await is kept in a temp across it
    const list = operands(node);
    let last = -1;
    for (let i = 0; i < list.length; i++) if (hasAwait(list[i])) last = i;
    const replace = new Map();
    for (let i = 0; i <= last; i++) {
      const operand = list[i];
      const lifted = liftExpr(operand, out);
      if (i === last || PURE_KINDS.has(lifted[N_KIND]) || isTemp(lifted) || lifted[N_TYPE] === T.none) {
        if (lifted !== operand) replace.set(operand, lifted);
        continue;
      }
      const t = temp(lifted[N_TYPE]);
      out.push(Assign(t, lifted));
      replace.set(operand, t);
    }
    return withOperands(node, replace);
  };

  const liftStmts = stmts => {
    const out = [];
    for (const s of stmts) liftStmt(s, out);
    return out;
  };

  const liftStmt = (s, out) => {
    if (s == null || !hasAwait(s)) {
      out.push(s);
      return;
    }
    switch (s[N_KIND]) {
      case K.Assign: {
        const target = s[N_A], value = s[N_B];
        if (value[N_KIND] === K.Await && target[N_KIND] === K.Local) {
          out.push(Assign(target, Await(liftExpr(value[N_A], out))));
          return;
        }
        out.push(Assign(target, liftExpr(value, out)));
        return;
      }

      case K.Await:
        out.push(Await(liftExpr(s[N_A], out)));
        return;

      case K.If:
        out.push([ K.If, T.none, s[N_FX], liftExpr(s[N_A], out), liftStmts(s[N_B]), s[N_C] ? liftStmts(s[N_C]) : s[N_C] ]);
        return;

      case K.Loop: {
        const [ body, label ] = s[N_C];
        let cond = s[N_A];
        const head = [];
        // an await in the condition: checked at the top of the body instead
        if (cond && hasAwait(cond)) {
          const c = liftExpr(cond, head);
          head.push([ K.If, T.none, FX.none, Un('!', T.i32, c), [ Break(null) ], null ]);
          cond = null;
        }
        out.push([ K.Loop, T.none, s[N_FX], cond, s[N_B], [ [ ...head, ...liftStmts(body) ], label ] ]);
        return;
      }

      case K.Block:
        out.push([ K.Block, T.none, s[N_FX], liftStmts(s[N_A]), s[N_B], s[N_C] ]);
        return;

      case K.Try:
        out.push([ K.Try, T.none, s[N_FX], liftStmts(s[N_A]), s[N_B], liftStmts(s[N_C]) ]);
        return;

      case K.Switch:
      case K.TypeSwitch: {
        const subject = liftExpr(s[N_A], out);
        const cases = s[N_B].map(c => {
          const copy = c.slice();
          copy[1] = liftStmts(c[1]);
          return copy;
        });
        out.push([ s[N_KIND], T.none, s[N_FX], subject, cases, s[N_C] ? liftStmts(s[N_C]) : s[N_C] ]);
        return;
      }

      default:
        // Return, Throw, Store, a call as a statement...: operands lifted in order
        out.push(liftExpr(s, out));
    }
  };

  const body = liftStmts(f.body);
  return { body, temps, frame: frameLocals(body) };
};

/**
 * The locals that must live in the frame: those whose value can be needed across a
 * suspension. Conservative, over the structured body in source order: suspension points
 * (awaits, and catches, which the wrapper enters afresh) split it into spans, and a local needs the frame when, in a span after the first it
 * appears in, it can be read before that span has certainly written it. A write is certain
 * when the conditional parts (branches, loop bodies, try blocks, lazy operands) open at it
 * are those open where the span began, or fewer of them: not a part entered since, nor a
 * sibling branch of the one the suspension is in. A loop that holds an await or a try is walked
 * twice, the second pass standing for every later iteration coming back round; one that
 * can `continue` (skipping writes at the end of its body) sends all it uses to the frame. Every other local is dead at each
 * suspension, so starting each step with it afresh loses nothing.
 */
const frameLocals = body => {
  const frame = new Set();
  let span = 0;
  let parts = 0;
  const open = [];     // the conditional parts entered, innermost last
  let spanOpen = [];   // those open where the current span began
  const firstSpan = new Map(); // name -> the span it first appears in
  const written = new Map();   // name -> the span it was last certainly written in

  const read = (name, inAwaitLoop) => {
    if (inAwaitLoop) return frame.add(name);
    if (!firstSpan.has(name)) firstSpan.set(name, span);
    else if (firstSpan.get(name) !== span && written.get(name) !== span) frame.add(name);
  };
  const write = (name, inAwaitLoop) => {
    if (inAwaitLoop) return frame.add(name);
    if (!firstSpan.has(name)) firstSpan.set(name, span);
    if (open.length <= spanOpen.length && open.every((part, i) => part === spanOpen[i])) written.set(name, span);
  };
  const suspend = () => {
    span++;
    spanOpen = open.slice();
  };
  // a conditional part: entered or not, so no write in it is certain for what follows
  const cond = (node, inAwaitLoop) => {
    open.push(++parts);
    walk(node, inAwaitLoop);
    open.pop();
  };

  const walk = (node, inAwaitLoop) => {
    if (!Array.isArray(node)) return;
    if (!isNode(node)) {
      for (const x of node) walk(x, inAwaitLoop);
      return;
    }
    const k = node[N_KIND];
    switch (k) {
      case K.Local:
        read(node[N_A], inAwaitLoop);
        return;

      case K.Assign: {
        const target = node[N_A], value = node[N_B];
        if (value[N_KIND] === K.Await) {
          // `x = await e`: e before the suspension, x after it
          walk(value[N_A], inAwaitLoop);
          suspend();
        } else walk(value, inAwaitLoop);
        if (target[N_KIND] === K.Local) write(target[N_A], inAwaitLoop);
        return;
      }

      case K.Await:
        walk(node[N_A], inAwaitLoop);
        suspend();
        return;

      case K.If:
        walk(node[N_A], inAwaitLoop);
        cond(node[N_B], inAwaitLoop);
        cond(node[N_C], inAwaitLoop);
        return;

      case K.Loop: {
        const [ stmts ] = node[N_C];
        if (inAwaitLoop || !hasSuspend(node) || hasContinue(stmts)) {
          const loop = inAwaitLoop || hasSuspend(node);
          cond(node[N_A], loop); cond(node[N_B], loop); cond(stmts, loop);
          return;
        }
        // as C runs it: cond, body, update, then again cond and body for the iterations
        // after, which resume where the last pass left off; one part for all of it
        open.push(++parts);
        walk(node[N_A], false); walk(stmts, false); walk(node[N_B], false);
        walk(node[N_A], false); walk(stmts, false);
        open.pop();
        return;
      }

      case K.Switch:
      case K.TypeSwitch:
        walk(node[N_A], inAwaitLoop);
        cond(node[N_B], inAwaitLoop);
        cond(node[N_C], inAwaitLoop);
        return;

      case K.Try:
        cond(node[N_A], inAwaitLoop);
        // the catch is entered afresh from the wrapper, as at a resume
        suspend();
        write(node[N_B], inAwaitLoop);
        cond(node[N_C], inAwaitLoop);
        return;

      case K.Select:
        walk(node[N_A], inAwaitLoop);
        cond(node[N_B], inAwaitLoop);
        cond(node[N_C], inAwaitLoop);
        return;

      case K.Bin:
        if (node[N_A] === '&&' || node[N_A] === '||') {
          walk(node[N_B], inAwaitLoop);
          cond(node[N_C], inAwaitLoop);
          return;
        }
    }
    walk(node[N_A], inAwaitLoop); walk(node[N_B], inAwaitLoop); walk(node[N_C], inAwaitLoop);
  };
  walk(body, false);
  return frame;
};
