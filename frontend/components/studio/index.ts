// Sprint 046 Session B — Studio card surface barrel.
//
// Session C wires these into `inbox-v5.tsx`'s `navTab === 'studio'`
// branch via a `StandalonePart` switch. Importing from this barrel keeps
// that wiring terse (one import line for the five new cards).

export { SuggestedFixCard } from './suggested-fix'
export type { SuggestedFixCardProps, SuggestedFixTarget } from './suggested-fix'

export { QuestionChoicesCard } from './question-choices'
export type { QuestionChoicesCardProps, QuestionOption } from './question-choices'

export { AuditReportCard } from './audit-report'
export type { AuditReportCardProps, AuditReportRowData } from './audit-report'

export { StateSnapshotCard } from './state-snapshot'
export type {
  StateSnapshotCardProps,
  StateSnapshotData,
  StateSnapshotSummary,
} from './state-snapshot'

export { ReasoningLine } from './reasoning-line'
export type { ReasoningLineProps } from './reasoning-line'

export { StudioChat } from './studio-chat'
export type { StudioChatProps } from './studio-chat'

export { StudioSurface } from './studio-surface'
export type { StudioSurfaceProps } from './studio-surface'

export {
  STUDIO_COLORS,
  STUDIO_TOKENS_V2,
  STUDIO_CATEGORY_STYLES,
  STUDIO_STATUS_DOT,
  getStudioCategoryStyle,
  type StudioCategoryKey,
  type StudioStatus,
} from './tokens'

// Sprint 046 — Studio design-overhaul shell surface.
export { StudioShell } from './studio-shell'
export type { StudioShellProps } from './studio-shell'
export {
  StudioShellContext,
  useStudioShell,
  type PreviewInputState,
  type RightPanelTab,
  type StudioShellContextValue,
} from './studio-shell-context'
export { TopBar } from './top-bar'
export type { TopBarProps } from './top-bar'
export { LeftRailV2 } from './left-rail'
export type { LeftRailV2Props } from './left-rail'
export { RightPanelTabs } from './right-panel-tabs'
export type { RightPanelTabsProps } from './right-panel-tabs'
export { PlanTab } from './tabs/plan-tab'
export type { PlanTabProps } from './tabs/plan-tab'
export { PreviewTab } from './tabs/preview-tab'
export { TestsTab } from './tabs/tests-tab'
export { LedgerTab } from './tabs/ledger-tab'
export type { LedgerTabProps } from './tabs/ledger-tab'
export { ReferencePicker } from './reference-picker'
export type {
  ReferencePickerProps,
  ReferenceTarget,
  ReferenceKind,
} from './reference-picker'
export { renderInlineCodePills } from './utils/render-code-pills'
