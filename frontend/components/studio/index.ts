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

export {
  STUDIO_COLORS,
  STUDIO_CATEGORY_STYLES,
  STUDIO_STATUS_DOT,
  getStudioCategoryStyle,
  type StudioCategoryKey,
  type StudioStatus,
} from './tokens'
