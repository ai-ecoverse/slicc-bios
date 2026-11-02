export function ownerSnapshot(root, frameId) {
  const domNodes = [];
  function visit(node, documentFrame) {
    if (!node) return;
    const index = domNodes.length;
    const document = node.nodeName === '#document' || node.nodeName === undefined;
    const entry = {
      nodeType: node.nodeType ?? (document ? 9 : 1),
      nodeName: node.nodeName ?? '#document',
      frameId: node.frameId ?? (document ? documentFrame : undefined),
      backendNodeId: node.backendNodeId ?? index + 1,
      documentURL: node.documentURL,
      attributes: (node.attributes ?? []).flatMap((name, at, all) =>
        at % 2 ? [] : [{ name, value: all[at + 1] }]
      ),
    };
    domNodes.push(entry);
    if (node.contentDocument)
      entry.contentDocumentIndex = visit(node.contentDocument, node.frameId);
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.templateContent ? [node.templateContent] : []),
    ])
      visit(child, documentFrame);
    return index;
  }
  visit(root, frameId);
  return { domNodes, layoutTreeNodes: [], computedStyles: [] };
}
