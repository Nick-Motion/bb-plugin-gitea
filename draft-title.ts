const draftPrefix = /^\s*(?:WIP:|\[WIP\])\s*/i;

export function isDraftTitle(title: string) {
  return draftPrefix.test(title);
}

export function draftTitle(title: string, draft: boolean) {
  const clean = title.replace(draftPrefix, "");
  return draft ? `WIP: ${clean}` : clean;
}
