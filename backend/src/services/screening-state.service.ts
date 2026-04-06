/**
 * Screening State Service
 *
 * Computes screening state from conversation history and open tasks.
 * Injected as a content block so the AI never needs to self-report
 * what screening info it has — code tracks it deterministically.
 *
 * Phases:
 *   GATHER        — nationality or composition not yet mentioned
 *   DECIDE        — both mentioned, no screening decision task yet
 *   POST_DECISION — a screening escalation already exists
 */

export interface ScreeningState {
  phase: 'GATHER' | 'DECIDE' | 'POST_DECISION';
  nationalityMentioned: boolean;
  compositionMentioned: boolean;
  screeningDecisionExists: boolean;
  screeningDecisionTitle: string | null;
  checklistCreated: boolean;
  awaitingManagerReview: boolean;
  hint: string;
}

// ─── Nationality indicators ────────────────────────────────────────────────

const NATIONALITY_PATTERNS = [
  // Arab nationalities (English)
  /\b(egyptian|jordanian|saudi|emirati|lebanese|iraqi|syrian|palestinian|moroccan|tunisian|algerian|libyan|sudanese|yemeni|omani|bahraini|kuwaiti|qatari)\b/i,
  // Arab countries
  /\b(egypt|jordan|saudi|emirates|uae|lebanon|iraq|syria|palestine|morocco|tunisia|algeria|libya|sudan|yemen|oman|bahrain|kuwait|qatar)\b/i,
  // Non-Arab nationalities
  /\b(american|british|french|german|italian|spanish|russian|chinese|japanese|korean|indian|turkish|iranian|pakistani|brazilian|canadian|australian|dutch|swedish|swiss|belgian|polish|greek|portuguese|mexican|colombian|argentinian|chilean|south african|nigerian|kenyan|ghanaian|ethiopian|filipino|thai|vietnamese|indonesian|malaysian|singaporean)\b/i,
  // Non-Arab countries
  /\b(america|usa|uk|england|france|germany|italy|spain|russia|china|japan|korea|india|turkey|iran|pakistan|brazil|canada|australia|netherlands|sweden|switzerland|belgium|poland|greece|portugal|mexico|colombia|argentina|chile|south africa|nigeria|kenya|ghana|ethiopia|philippines|thailand|vietnam|indonesia|malaysia|singapore)\b/i,
  // "from [place]" pattern
  /\bfrom\s+[A-Z][a-z]{2,}/,
  // Arabic nationality words
  /مصري|أردني|سعودي|إماراتي|لبناني|عراقي|سوري|فلسطيني|مغربي|تونسي|جزائري|ليبي|سوداني|يمني|عماني|بحريني|كويتي|قطري/,
  // Arabic country names
  /مصر|الأردن|السعودية|الإمارات|لبنان|العراق|سوريا|فلسطين|المغرب|تونس|الجزائر|ليبيا|السودان|اليمن|عمان|البحرين|الكويت|قطر/,
  // "from" in Arabic
  /من\s+\S{2,}/,
  // Arabizi patterns for countries/nationalities
  /\b(masry|masri|ordony|so3ody|lebnany|3ra2y)\b/i,
  // Generic nationality discussion
  /\b(nationality|national|citizen|passport\s+from|country|جنسية)\b/i,
];

// ─── Composition indicators ────────────────────────────────────────────────

const COMPOSITION_PATTERNS = [
  // Family
  /\b(wife|husband|spouse|married|family|families|children|child|kids|kid|son|daughter|baby|toddler|infant|pregnant)\b/i,
  /\b(brother|sister|sibling|siblings|parent|parents|mother|father|mom|dad|uncle|aunt)\b/i,
  // Group
  /\b(couple|solo|alone|by myself|single|group|friends|colleagues|guys|girls|ladies|gentlemen|mates)\b/i,
  // Gender
  /\b(male|female|men|women|boys|girls|man|woman|all-male|all-female|mixed)\b/i,
  // Count with relationship context
  /\b(just me|two of us|three of us|four of us|five of us|me and my|myself and my|with my)\b/i,
  // Arabic family words
  /زوجتي|زوجي|مراتي|جوزي|عائلة|عيلة|أطفال|أولاد|ولاد|بنت|ابن|ابني|بنتي|أخويا|أختي|ماما|بابا/,
  // Arabic composition words
  /لوحدي|لوحده|لوحدها|مجموعة|صحاب|أصحاب|شباب|بنات|خطيبتي|خطيبي/,
  // Arabizi family/composition
  /\b(mrati|gozi|3eelti|wladi|lo7di|so7abi|shabab|banat|5atibt)\b/i,
  // Numbers with guests/people
  /\b\d+\s*(guests?|people|persons?|adults?|ضيوف|أشخاص|أفراد)\b/i,
];

// Screening-related task titles
const SCREENING_TITLES = [
  'eligible-non-arab', 'eligible-arab-females', 'eligible-arab-family-pending-docs',
  'eligible-arab-couple-pending-cert', 'eligible-lebanese-emirati-single',
  'violation-arab-single-male', 'violation-arab-male-group', 'violation-arab-unmarried-couple',
  'violation-arab-mixed-group', 'violation-mixed-unmarried-couple', 'violation-no-documents',
  'escalation-unclear', 'awaiting-manager-review',
];

/**
 * Scan guest messages for nationality and composition mentions.
 */
function scanGuestMessages(
  messages: Array<{ role: string; content: string }>,
): { nationalityMentioned: boolean; compositionMentioned: boolean } {
  const guestTexts = messages
    .filter(m => m.role === 'GUEST')
    .map(m => m.content)
    .join(' ');

  const nationalityMentioned = NATIONALITY_PATTERNS.some(p => p.test(guestTexts));
  const compositionMentioned = COMPOSITION_PATTERNS.some(p => p.test(guestTexts));

  return { nationalityMentioned, compositionMentioned };
}

/**
 * Compute the screening state for a conversation.
 */
export function computeScreeningState(
  messages: Array<{ role: string; content: string }>,
  openTasks: Array<{ title: string; status: string }>,
  checklistCreated: boolean,
): ScreeningState {
  try {
    const { nationalityMentioned, compositionMentioned } = scanGuestMessages(messages);

    const screeningTask = openTasks.find(t => SCREENING_TITLES.includes(t.title));
    const screeningDecisionExists = !!screeningTask;
    const screeningDecisionTitle = screeningTask?.title || null;
    const awaitingManagerReview = screeningDecisionExists;

    // Phase logic
    let phase: 'GATHER' | 'DECIDE' | 'POST_DECISION';
    if (screeningDecisionExists) {
      phase = 'POST_DECISION';
    } else if (nationalityMentioned && compositionMentioned) {
      phase = 'DECIDE';
    } else {
      phase = 'GATHER';
    }

    // Build hint
    let hint: string;
    switch (phase) {
      case 'GATHER': {
        const missing: string[] = [];
        if (!nationalityMentioned) missing.push('nationality');
        if (!compositionMentioned) missing.push('party composition');
        hint = `SCREENING PHASE: Gathering info. Missing: ${missing.join(' and ')}. Ask the guest for ${missing.join(' and ')} before making any screening decision.`;
        break;
      }
      case 'DECIDE':
        hint = 'SCREENING PHASE: Info gathered. Nationality and party composition have been mentioned. Apply screening rules now and escalate with the appropriate title.';
        if (checklistCreated) hint += ' Document checklist already created — do not call create_document_checklist again.';
        break;
      case 'POST_DECISION':
        hint = `SCREENING PHASE: Decision made. Escalation "${screeningDecisionTitle}" already exists. Do NOT re-screen or re-escalate. Respond to the guest's question normally.`;
        if (awaitingManagerReview) {
          hint += ' The manager has been notified — tell the guest you\'re checking on availability if they ask.';
        }
        break;
    }

    return {
      phase,
      nationalityMentioned,
      compositionMentioned,
      screeningDecisionExists,
      screeningDecisionTitle,
      checklistCreated,
      awaitingManagerReview,
      hint,
    };
  } catch (err) {
    console.warn('[ScreeningState] Error computing state:', err);
    return {
      phase: 'GATHER',
      nationalityMentioned: false,
      compositionMentioned: false,
      screeningDecisionExists: false,
      screeningDecisionTitle: null,
      checklistCreated: false,
      awaitingManagerReview: false,
      hint: 'SCREENING PHASE: Gathering info. Missing: nationality and party composition.',
    };
  }
}
