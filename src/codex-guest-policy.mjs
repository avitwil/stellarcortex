// Supported configuration hardening is defense in depth, NOT proof that every
// native tool is removed. Guest Codex remains gated until runtime isolation is verified.
export const CODEX_GUEST_CONFIG = Object.freeze({
  'features.shell_tool': false,
  'features.shell_snapshot': false,
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.browser_use_full_cdp_access': false,
  'features.computer_use': false,
  'features.multi_agent': false,
  'features.in_app_local_automation': false,
  'features.view_image': false,
  'tools.view_image': false,
  web_search: 'disabled',
  'shell_environment_policy.inherit': 'none',
});
export function codexGuestParams(params) {
  // A writable host workspace must never be passed to an unverified guest-mode Codex.
  return {
    ...params,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    environments: [],
    runtimeWorkspaceRoots: [],
    selectedCapabilityRoots: [],
    config: { ...params.config, ...CODEX_GUEST_CONFIG },
  };
}
export function denyNativeGuestRequest(method) {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
  ].includes(method);
}
