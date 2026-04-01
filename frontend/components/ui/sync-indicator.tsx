'use client'

import React, { useState, useEffect, useCallback } from 'react'

interface SyncIndicatorProps {
  lastSyncedAt: string | null
  syncIntervalMs?: number
  onSync: () => void
  isSyncing?: boolean
}

export function SyncIndicator({
  lastSyncedAt,
  syncIntervalMs = 120000,
  onSync,
  isSyncing = false,
}: SyncIndicatorProps) {
  const [remainingMs, setRemainingMs] = useState(syncIntervalMs)

  const calcRemaining = useCallback(() => {
    if (!lastSyncedAt) return syncIntervalMs
    const elapsed = Date.now() - new Date(lastSyncedAt).getTime()
    return Math.max(0, syncIntervalMs - elapsed)
  }, [lastSyncedAt, syncIntervalMs])

  useEffect(() => {
    setRemainingMs(calcRemaining())
    const timer = setInterval(() => {
      const remaining = calcRemaining()
      setRemainingMs(remaining)
      // Auto-trigger sync when timer hits zero
      if (remaining <= 0 && !isSyncing) {
        onSync()
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [calcRemaining, isSyncing, onSync])

  const progress = lastSyncedAt
    ? Math.min(1, 1 - remainingMs / syncIntervalMs)
    : 0

  const totalSec = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  const timeLabel = `${minutes}:${String(seconds).padStart(2, '0')}`

  // SVG ring params
  const size = 32
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progress)

  const tooltipText = isSyncing
    ? 'Syncing messages...'
    : `Next sync in ${timeLabel} \u2014 click to sync now`

  return (
    <button
      onClick={onSync}
      disabled={isSyncing}
      title={tooltipText}
      className="relative flex items-center justify-center flex-shrink-0 cursor-pointer border-0 bg-transparent p-0 transition-opacity hover:opacity-80 disabled:cursor-default"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={isSyncing ? 'animate-spin' : ''}
        style={{ transform: isSyncing ? undefined : 'rotate(-90deg)' }}
      >
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#E5E5E5"
          strokeWidth={strokeWidth}
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={isSyncing ? '#999999' : '#0070F3'}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          style={{ transition: isSyncing ? 'none' : 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      {/* Center text */}
      {!isSyncing && (
        <span
          className="absolute inset-0 flex items-center justify-center select-none pointer-events-none"
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: '#666666',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            letterSpacing: '-0.02em',
          }}
        >
          {timeLabel}
        </span>
      )}
    </button>
  )
}
