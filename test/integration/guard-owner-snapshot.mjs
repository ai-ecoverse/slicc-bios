export function ownerSnapshot(root, frameId) {
  const documents = [];
  const strings = [];
  let nextBackend = 1;
  const string = (value) => {
    value ??= '';
    let index = strings.indexOf(value);
    if (index < 0) index = strings.push(value) - 1;
    return index;
  };
  function document(root, id) {
    const index = documents.length;
    const nodes = {
      nodeName: [],
      backendNodeId: [],
      attributes: [],
      contentDocumentIndex: { index: [], value: [] },
    };
    documents.push({ frameId: string(id), documentURL: string(root?.documentURL), nodes });
    function visit(node) {
      if (!node) return;
      const at = nodes.nodeName.length;
      nodes.nodeName.push(string(node.nodeName ?? '#document'));
      nodes.backendNodeId.push(node.backendNodeId ?? nextBackend++);
      nodes.attributes.push((node.attributes ?? []).map(string));
      if (node.contentDocument) {
        nodes.contentDocumentIndex.index.push(at);
        nodes.contentDocumentIndex.value.push(document(node.contentDocument, node.frameId));
      }
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        ...(node.templateContent ? [node.templateContent] : []),
      ])
        visit(child);
    }
    visit(root);
    return index;
  }
  document(root, frameId);
  return { documents, strings };
}

export function treeDocument(tree) {
  return {
    nodeName: '#document',
    documentURL: tree.frame.url,
    children: (tree.childFrames ?? []).map((child) => ({
      nodeName: 'IFRAME',
      frameId: child.frame.id,
      contentDocument: treeDocument(child),
    })),
  };
}
