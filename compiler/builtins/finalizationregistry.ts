import type {} from './porffor.d.ts';

// 26.2 FinalizationRegistry: [target, heldValue, unregisterToken] cells, and the cleanup
// callback. Targets are held as WeakRef's are (strongly: the spec lets an implementation
// never collect them, and never call the callback). Layout: cells (array), cleanup callback

// CanBeHeldWeakly: an object or a symbol
export const __Porffor_finReg_holdable = (v: any): boolean => Porffor.object.isObjectOrSymbol(v);

export const __Porffor_finReg_cells = (reg: any): any[] => {
  if (Porffor.type(reg) != Porffor.TYPES.finalizationregistry) throw new TypeError("FinalizationRegistry.prototype method expects 'this' to be a FinalizationRegistry");
  return Porffor.IR.loadJv(reg, 0);
};

export const FinalizationRegistry = function (cleanupCallback: any): FinalizationRegistry {
  if (!new.target) throw new TypeError("Constructor FinalizationRegistry requires 'new'");
  if (typeof cleanupCallback !== 'function') throw new TypeError('FinalizationRegistry: the cleanup callback is not a function');

  const out: FinalizationRegistry = Porffor.malloc(16);
  Porffor.IR.storeJv(out, 0, Porffor.array.new(3));
  Porffor.IR.storeJv(out, 8, cleanupCallback);
  return out;
};

export const __FinalizationRegistry_prototype_register = function (this: any, target: any, heldValue: any, unregisterToken: any): void {
  const cells: any[] = __Porffor_finReg_cells(this);
  if (!__Porffor_finReg_holdable(target)) throw new TypeError('FinalizationRegistry.prototype.register: the target must be an object or symbol');
  if (target === heldValue) throw new TypeError('FinalizationRegistry.prototype.register: the target and held value must differ');
  if (!__Porffor_finReg_holdable(unregisterToken)) {
    if (unregisterToken !== undefined) throw new TypeError('FinalizationRegistry.prototype.register: the unregister token must be an object, symbol or undefined');
  }

  cells.push(target, heldValue, unregisterToken);
};

export const __FinalizationRegistry_prototype_unregister = function (this: any, unregisterToken: any): boolean {
  const cells: any[] = __Porffor_finReg_cells(this);
  if (!__Porffor_finReg_holdable(unregisterToken)) throw new TypeError('FinalizationRegistry.prototype.unregister: the token must be an object or symbol');

  // keep the cells registered with another token (compacting in place)
  let removed: boolean = false;
  let kept: i32 = 0;
  const len: i32 = cells.length;
  for (let i: i32 = 0; i < len; i += 3) {
    if (cells[i + 2] === unregisterToken) {
      removed = true;
      continue;
    }
    cells[kept] = cells[i];
    cells[kept + 1] = cells[i + 1];
    cells[kept + 2] = cells[i + 2];
    kept += 3;
  }
  cells.length = kept;
  return removed;
};

// (a proposal's) cleanupSome: nothing has been collected, so nothing to clean up
export const __FinalizationRegistry_prototype_cleanupSome = function (this: any, callback: any): void {
  __Porffor_finReg_cells(this);
  if (callback !== undefined) if (typeof callback !== 'function') throw new TypeError('FinalizationRegistry.prototype.cleanupSome: the callback is not a function');
};
