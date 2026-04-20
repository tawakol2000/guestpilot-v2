'use client'

/**
 * Sprint 045 refinement E1 — styled confirmation dialog for destructive
 * BUILD-mode actions (rollback). Wraps the existing @radix-ui/react-dialog
 * primitive rather than importing shadcn's AlertDialog (not in dep tree) —
 * radix Dialog provides the same focus trap, escape-to-close, and portal
 * behavior, so functional parity with AlertDialog is preserved without a
 * new dependency.
 *
 * The dialog tints its primary action with the tuning palette's danger
 * colour so "Roll back" reads as destructive without falling back to the
 * browser's ugly confirm() modal.
 */
import { useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { TUNING_COLORS } from '../studio/tokens'

export function ConfirmRollbackDialog({
  open,
  onOpenChange,
  title,
  summary,
  confirmLabel = 'Roll back',
  cancelLabel = 'Cancel',
  onConfirm,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: string
  summary: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)

  async function handleConfirm() {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-md"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          borderColor: TUNING_COLORS.hairline,
          color: TUNING_COLORS.ink,
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: TUNING_COLORS.ink }}>{title}</DialogTitle>
          <DialogDescription style={{ color: TUNING_COLORS.inkMuted }}>
            {summary}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose
            disabled={pending}
            className="inline-flex h-9 items-center justify-center rounded-md border bg-white px-3 text-sm font-medium disabled:opacity-60"
            style={{
              borderColor: TUNING_COLORS.hairline,
              color: TUNING_COLORS.inkMuted,
            }}
          >
            {cancelLabel}
          </DialogClose>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: TUNING_COLORS.dangerFg }}
            autoFocus
          >
            {pending ? (
              <Loader2 size={14} strokeWidth={2.25} className="animate-spin" />
            ) : (
              <RotateCcw size={14} strokeWidth={2.25} />
            )}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
