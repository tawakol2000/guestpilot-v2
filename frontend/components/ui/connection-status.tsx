'use client'

import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface ConnectionStatusProps {
  status: 'connected' | 'delayed' | 'reconnecting' | 'disconnected'
}

const config = {
  connected: {
    dot: 'bg-emerald-500',
    text: 'Live',
    tooltip: 'Real-time connection active',
  },
  delayed: {
    dot: 'bg-blue-500',
    text: 'Live (delayed)',
    tooltip: 'WebSocket unavailable \u2014 using 5-second polling',
  },
  reconnecting: {
    dot: 'bg-yellow-500 animate-pulse',
    text: 'Reconnecting...',
    tooltip: 'Connection lost \u2014 reconnecting...',
  },
  disconnected: {
    dot: 'bg-red-500',
    text: 'Offline',
    tooltip: 'No network connection',
  },
} as const

export function ConnectionStatus({ status }: ConnectionStatusProps) {
  const { dot, text, tooltip } = config[status]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 cursor-default select-none">
          <span
            className={`inline-block size-2 shrink-0 rounded-full ${dot}`}
          />
          <span className="text-[11px] leading-none text-muted-foreground">
            {text}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
