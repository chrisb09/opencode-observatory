import assert from "node:assert/strict";

export function assertAnalyticsEquivalent(actual:any,expected:any,path="analytics"):void {
  if(typeof actual==="number"&&typeof expected==="number") {
    assert(Math.abs(actual-expected)<=Math.max(1e-8,Math.abs(expected)*1e-12),`Numeric mismatch at ${path}`);
  } else if(actual!==null&&expected!==null&&typeof actual==="object"&&typeof expected==="object") {
    assert.deepEqual(Object.keys(actual).filter(key=>actual[key]!==undefined).sort(),Object.keys(expected).filter(key=>expected[key]!==undefined).sort(),`Keys differ at ${path}`);
    for(const key of Object.keys(expected))assertAnalyticsEquivalent(actual[key],expected[key],`${path}.${key}`);
  } else assert.equal(actual,expected,`Value differs at ${path}`);
}
