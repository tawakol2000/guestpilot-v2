// Feature 043 — Polymorphic action-card registry.
//
// Keys a Task's `type` string to the React component that renders its
// Accept/Reject/Preview/Send card inside the inbox right-panel Actions region.
// Adding a new escalation type is one import + one map entry here — no
// inbox-component changes required.
import type { FC } from 'react'
import type { ApiTask } from '@/lib/api'
import TimeRequestActionCard from './time-request-action-card'

export interface ActionCardProps {
  task: ApiTask
  onResolved: (taskId: string) => void
  onReservationUpdated?: (reservation: { id: string; scheduledCheckInAt: string | null; scheduledCheckOutAt: string | null }) => void
}

export const ACTION_CARD_REGISTRY: Record<string, FC<ActionCardProps>> = {
  late_checkout_request: TimeRequestActionCard,
  early_checkin_request: TimeRequestActionCard,
}

export function getActionCardFor(task: ApiTask): FC<ActionCardProps> | null {
  return ACTION_CARD_REGISTRY[task.type] ?? null
}
