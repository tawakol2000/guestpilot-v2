/**
 * Sprint 057-A F1 — Coverage regression lock for TOOL_VERB_MAP.
 *
 * This test fails the build if names.ts gains a tool without a
 * corresponding TOOL_VERB_MAP entry. Every key in
 * TUNING_AGENT_TOOL_NAMES must resolve to a verb.
 */
import { describe, it, expect } from 'vitest'
import { TUNING_AGENT_TOOL_NAMES } from '../../../../backend/src/build-tune-agent/tools/names'
import { TOOL_VERB_MAP } from '../tool-verbs'

const SERVER_PREFIX = 'mcp__tuning-agent__'

describe('TOOL_VERB_MAP coverage', () => {
  it('covers every tool declared in names.ts', () => {
    const missingVerbs: string[] = []
    for (const fullName of Object.values(TUNING_AGENT_TOOL_NAMES)) {
      const shortName = fullName.replace(SERVER_PREFIX, '')
      if (!TOOL_VERB_MAP[shortName]) {
        missingVerbs.push(shortName)
      }
    }
    expect(missingVerbs).toEqual([])
  })
})
