import assert from 'node:assert/strict';

export const sameOriginChildMarkup =
  '<!doctype html><title>675 same-origin child</title><script type="module">await fetch("/same-child-ready"); if (document.modelContext) document.modelContext.registerTool({ name: "child_add", description: "Child adds ten", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, execute: ({a,b}) => String(a+b+10) });</script>';

export function sameOriginTools(tools) {
  const root = tools.find(({ name }) => name === 'add');
  const child = tools.find(({ name }) => name === 'child_add');
  assert.ok(root && child, 'root and same-origin child tools must both list');
  assert.ok(typeof root.frameId === 'string' && root.frameId);
  assert.ok(typeof child.frameId === 'string' && child.frameId);
  assert.notEqual(root.frameId, child.frameId, 'tools need distinct native frames');
  assert.equal(root.origin, child.origin, 'child must actually be same-origin');
  return { root, child };
}
