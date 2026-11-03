/**
 * Reload Remote File: re-read an open remote file from its container or
 * host, so a change polling missed (same size within the same second of
 * `stat`'s mtime) or hasn't seen yet shows now.
 */

/** The menu and palette `when` for remote editors. */
export const REMOTE_RESOURCE_WHEN =
  'resourceScheme =~ /^remotefs-(container|ssh)$/';

export interface ReloadSteps {
  /** Whether the editor has unsaved changes. */
  isDirty(): boolean;
  /** Ask before unsaved changes are thrown away; true to go ahead. */
  confirmDiscard(): Promise<boolean>;
  /** Make the editor the active one, where it already is. */
  show(): Promise<void>;
  /**
   * Re-read the active editor's file (`workbench.action.files.revert`,
   * which reads through the provider even when nothing looks changed).
   */
  revert(): Promise<void>;
}

/** Reload an editor; false when the user kept their unsaved changes. */
export async function reloadEditor(steps: ReloadSteps): Promise<boolean> {
  if (steps.isDirty() && !(await steps.confirmDiscard())) {
    return false;
  }
  await steps.show();
  await steps.revert();
  return true;
}
