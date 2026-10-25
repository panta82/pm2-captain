// The right-click menu, which Electron leaves to the app: Copy and Select All
// on the page, the editing commands in text fields, and for a link that leaves
// the app, opening or copying it.
import {
  type BaseWindow,
  type ContextMenuParams,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
  app,
  clipboard,
} from 'electron';

type IMenuParams = Pick<
  ContextMenuParams,
  'x' | 'y' | 'linkURL' | 'isEditable' | 'editFlags' | 'selectionText'
>;
type IMenuContents = Pick<
  WebContents,
  'getURL' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'inspectElement'
>;

/** A web link to somewhere other than the page's own origin, which the app's routes use. */
function externalLink(linkURL: string, pageURL: string) {
  if (!URL.canParse(linkURL)) {
    return null;
  }
  const link = new URL(linkURL);
  const isWeb = link.protocol === 'https:' || link.protocol === 'http:';
  const isOwn = URL.canParse(pageURL) && new URL(pageURL).origin === link.origin;
  return isWeb && !isOwn ? link.toString() : null;
}

/** The items for one right-click, in groups that separators divide. */
export function contextMenuTemplate(
  params: IMenuParams,
  contents: IMenuContents,
  openLink: ((url: string) => void) | null
): MenuItemConstructorOptions[] {
  const { editFlags } = params;
  const groups: MenuItemConstructorOptions[][] = [];
  const link = externalLink(params.linkURL, contents.getURL());
  if (link && openLink) {
    groups.push([
      { label: 'Open Link in Browser', click: () => openLink(link) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
    ]);
  }
  if (params.isEditable) {
    groups.push(
      [
        { label: 'Undo', enabled: editFlags.canUndo, click: () => contents.undo() },
        { label: 'Redo', enabled: editFlags.canRedo, click: () => contents.redo() },
      ],
      [
        { label: 'Cut', enabled: editFlags.canCut, click: () => contents.cut() },
        { label: 'Copy', enabled: editFlags.canCopy, click: () => contents.copy() },
        { label: 'Paste', enabled: editFlags.canPaste, click: () => contents.paste() },
      ],
      [{ label: 'Select All', enabled: editFlags.canSelectAll, click: () => contents.selectAll() }]
    );
  } else {
    groups.push([
      { label: 'Copy', enabled: params.selectionText.length > 0, click: () => contents.copy() },
      { label: 'Select All', click: () => contents.selectAll() },
    ]);
  }
  // Development builds have the developer tools; packaged ones do not.
  if (!app.isPackaged) {
    groups.push([
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
    ]);
  }
  return groups.flatMap((group, index) =>
    index ? [{ type: 'separator' as const }, ...group] : group
  );
}

/**
 * Shows the menu on right-clicks in the contents, which are shown in the window.
 * Pages without links of their own, such as the find bar, pass no openLink.
 */
export function attachContextMenu(
  contents: WebContents,
  window: BaseWindow,
  openLink: ((url: string) => void) | null
) {
  contents.on('context-menu', (_event, params) => {
    if (!window.isDestroyed()) {
      Menu.buildFromTemplate(contextMenuTemplate(params, contents, openLink)).popup({ window });
    }
  });
}
