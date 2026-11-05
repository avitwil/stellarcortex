// Tests that read source files compare its content, not how the formatter laid it out.
export const compact = text =>
  text.replace(/\s*([(){}[\],;:=+?<>])\s*/g, '$1').replace(/[,;]([)\]}])/g, '$1');
export const compactCss = text =>
  text
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/=['"]([\w-]+)['"]\]/g, '=$1]');
