import assert from 'node:assert/strict';

export const sameOriginChildMarkup =
  '<!doctype html><title>675 same-origin child</title><script type="module">await fetch("/same-child-ready"); if (document.modelContext) document.modelContext.registerTool({ name: "child_add", description: "Child adds ten", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, execute: ({a,b}) => String(a+b+10) });</script>';

export function sameOriginTools(tools, route, frames) {
  assert.ok(['extension', 'link'].includes(route));
  assert.ok(Array.isArray(tools));
  assert.equal(
    tools.some((tool) => tool.error != null),
    false,
    'tool listing must not contain an error'
  );
  const root = tools.find(({ name }) => name === 'add');
  const child = tools.find(({ name }) => name === 'child_add' || name.endsWith('_child_add'));
  assert.ok(root, 'root tools must list beside the same-origin child');
  const rootFrame = frames.findLast((frame) => !frame.parentId);
  assert.ok(rootFrame?.id && rootFrame.loaderId && rootFrame.securityOrigin);
  const childFrame = frames.findLast(
    (frame) => frame.parentId === rootFrame.id && new URL(frame.url).pathname === '/same-child'
  );
  assert.ok(childFrame?.id && childFrame.loaderId);
  assert.notEqual(rootFrame.id, childFrame.id, 'fixture needs distinct native frames');
  assert.equal(
    rootFrame.securityOrigin,
    childFrame.securityOrigin,
    'child must actually be same-origin'
  );
  assert.ok(child, 'root and same-origin child tools must both list');
  return { root, child };
}

export async function sameOriginChildCall(selection, call) {
  assert.ok(selection.child, 'same-origin row requires the child call');
  const result = await call(selection.child.name);
  assert.match(result.stdout, /^15$/m);
  return result;
}
