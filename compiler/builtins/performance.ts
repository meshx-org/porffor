import type {} from './porffor.d.ts';

// User Timing (https://w3c.github.io/user-timing/) on the performance object: mark,
// measure, the entry getters and clears. performance.now and timeOrigin are native
// (builtins.js, the monotonic clock). Entries are plain objects with the
// PerformanceEntry fields (name, entryType, startTime, duration, detail) and a toJSON.

let __Porffor_performance_entries: any[] = Porffor.array.new(4);

export const __Porffor_performance_entry = (name: any, entryType: any, startTime: number, duration: number, detail: any): object => {
  const entry: object = {};
  entry.name = name;
  entry.entryType = entryType;
  entry.startTime = startTime;
  entry.duration = duration;
  entry.detail = detail === undefined ? null : detail;
  entry.toJSON = function (this: any) {
    const out: object = {};
    out.name = this.name;
    out.entryType = this.entryType;
    out.startTime = this.startTime;
    out.duration = this.duration;
    out.detail = this.detail;
    return out;
  };
  return entry;
};

// entries are kept in startTime order, as getEntries returns them
export const __Porffor_performance_record = (entry: object): void => {
  const list: any[] = __Porffor_performance_entries;
  let at: i32 = list.length;
  while (at > 0) {
    if (list[at - 1].startTime <= entry.startTime) break;
    at--;
  }
  list.splice(at, 0, entry);
};

// performance.mark(name, { startTime, detail })
export const __performance_mark = (markName: any, markOptions: any): object => {
  const name: any = ecma262.ToString(markName);
  let startTime: number = performance.now();
  let detail: any = null;
  if (markOptions != null) {
    if (markOptions.startTime !== undefined) {
      startTime = Number(markOptions.startTime);
      if (startTime < 0) throw new TypeError("Failed to execute 'mark' on 'Performance': the startTime cannot be negative");
    }
    if (markOptions.detail !== undefined) detail = markOptions.detail;
  }
  const entry: object = __Porffor_performance_entry(name, 'mark', startTime, 0, detail);
  __Porffor_performance_record(entry);
  return entry;
};

// A mark's name (the latest mark of that name) or a timestamp, as a time.
export const __Porffor_performance_time = (markOrTime: any): number => {
  if (typeof markOrTime === 'number') {
    if (markOrTime < 0) throw new TypeError("Failed to execute 'measure' on 'Performance': a time cannot be negative");
    return markOrTime;
  }
  const name: any = ecma262.ToString(markOrTime);
  const list: any[] = __Porffor_performance_entries;
  for (let i: i32 = list.length - 1; i >= 0; i--) {
    const entry: any = list[i];
    if (entry.entryType === 'mark') if (entry.name === name) return entry.startTime;
  }
  throw new SyntaxError("Failed to execute 'measure' on 'Performance': the mark '" + name + "' does not exist");
};

// performance.measure(name, startMark?, endMark?) or measure(name, { start, end, duration, detail })
export const __performance_measure = (measureName: any, startOrOptions: any, endMark: any): object => {
  const name: any = ecma262.ToString(measureName);
  let start: number = 0;
  let end: number = performance.now();
  let detail: any = null;

  if (startOrOptions != null && typeof startOrOptions === 'object') {
    const options: any = startOrOptions;
    if (endMark !== undefined) throw new TypeError("Failed to execute 'measure' on 'Performance': an end mark cannot be given with options");
    const hasStart: boolean = options.start !== undefined;
    const hasEnd: boolean = options.end !== undefined;
    const hasDuration: boolean = options.duration !== undefined;
    if (hasStart && hasEnd && hasDuration) throw new TypeError("Failed to execute 'measure' on 'Performance': start, end and duration cannot all be given");
    if (hasEnd) end = __Porffor_performance_time(options.end);
      else if (hasStart && hasDuration) end = __Porffor_performance_time(options.start) + Number(options.duration);
    if (hasStart) start = __Porffor_performance_time(options.start);
      else if (hasDuration && hasEnd) start = end - Number(options.duration);
    if (options.detail !== undefined) detail = options.detail;
  } else {
    if (startOrOptions !== undefined) start = __Porffor_performance_time(startOrOptions);
    if (endMark !== undefined) end = __Porffor_performance_time(endMark);
  }

  const entry: object = __Porffor_performance_entry(name, 'measure', start, end - start, detail);
  __Porffor_performance_record(entry);
  return entry;
};

export const __performance_getEntries = (): any[] => {
  return __Porffor_performance_entries.slice();
};

// No closures in builtins: the filters are loops.
// Entries with a given type (null: any) and name (null: any), or, with keep false, the rest.
export const __Porffor_performance_select = (entryType: any, entryName: any, keep: boolean): any[] => {
  const list: any[] = __Porffor_performance_entries;
  const out: any[] = Porffor.array.new(4);
  let n: i32 = 0;
  const len: i32 = list.length;
  for (let i: i32 = 0; i < len; i++) {
    const entry: any = list[i];
    let match: boolean = true;
    if (entryType !== null) if (entry.entryType !== entryType) match = false;
    if (entryName !== null) if (entry.name !== entryName) match = false;
    if (match == keep) out[n++] = entry;
  }
  return out;
};

export const __performance_getEntriesByType = (entryType: any): any[] => {
  return __Porffor_performance_select(ecma262.ToString(entryType), null, true);
};

export const __performance_getEntriesByName = (entryName: any, entryType: any): any[] => {
  const type: any = entryType === undefined ? null : ecma262.ToString(entryType);
  return __Porffor_performance_select(type, ecma262.ToString(entryName), true);
};

export const __Porffor_performance_clear = (entryType: any, entryName: any): void => {
  const name: any = entryName === undefined ? null : ecma262.ToString(entryName);
  __Porffor_performance_entries = __Porffor_performance_select(entryType, name, false);
};

export const __performance_clearMarks = (markName: any): void => {
  __Porffor_performance_clear('mark', markName);
};

export const __performance_clearMeasures = (measureName: any): void => {
  __Porffor_performance_clear('measure', measureName);
};

export const __performance_toJSON = (): object => {
  const out: object = {};
  out.timeOrigin = performance.timeOrigin;
  return out;
};
