export default ({ ERRORS }) => {
  let out = '';

  const errors = [];
  const error = name => {
    errors.push(name);
    out += `
export const ${name} = function (
  ${name === 'AggregateError' ? 'errors: any,' : ''}${name === 'SuppressedError' ? 'error: any, suppressed: any,' : ''} message: any, options: any
): ${name} {
  if (message === undefined) message = '';
    else message = ecma262.ToString(message);

  // Reached through super() from a subclass: the instance is this (a plain object whose
  // prototype chain reaches ${name}.prototype), and super() discards the block returned
  // below, so the message getter would read nothing. Give the instance the own
  // non-enumerable message property the spec defines instead.
  if (new.target) if (new.target !== ${name}) if (Porffor.type(this) == Porffor.TYPES.object)
    __Porffor_object_define(this, 'message', message, 0b1010);

  const obj: ${name} = Porffor.malloc(8);
  Porffor.IR.storeJv(obj, 0, message);

  // InstallErrorCause: an options object with a cause gives the error its cause (a program that
  // never names cause cannot give one, nor see it: program.errorCause)
  if (Porffor.comptime.flag\`program.errorCause\`) {
    if (Porffor.object.isObject(options)) if ('cause' in options) obj.cause = options.cause;
  }

  // https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-aggregate-error
  ${name === 'AggregateError' ? `
  const errorsList: any[] = __Array_from(errors);
  // TODO: should not be enumerable
  obj.errors = errorsList;
  ` : ''}
  ${name === 'SuppressedError' ? `
  // https://tc39.es/proposal-explicit-resource-management/#sec-suppressederror-constructor
  obj.error = error;
  obj.suppressed = suppressed;
  ` : ''}

  return obj;
};

export const __${name}_prototype_constructor$get = function (this: ${name}) {
  return ${name};
};

export const __${name}_prototype_name$get = function (this: ${name}) {
  return '${name}';
};

export const __${name}_prototype_message$get = function (this: ${name}) {
  return Porffor.IR.loadJv(this, 0);
};

// the stack: Porffor keeps no frames, so only the error's own line (a stack's first, as V8
// writes it)
export const __${name}_prototype_stack$get = function (this: any) {
  return Porffor.callThis(__${name}_prototype_toString, this);
};

// generic per spec: reads name and message off any this, so a subclass instance's own
// message and name are seen (typed as ${name}, both would resolve to the ${name} getters)
export const __${name}_prototype_toString = function (this: any) {
  const name: any = this.name;
  const message: any = this.message;
  if (message.length == 0) {
    return name;
  }

  return name + ': ' + message;
};\n`;
  };

  for (const x of ERRORS) error(x);

  out += `
export const __Error_isError = (x: unknown): boolean => Porffor.fastAnd(Porffor.type(x) >= Porffor.TYPES.error, Porffor.type(x) <= Porffor.TYPES.suppressederror);`;

  return out;
};
