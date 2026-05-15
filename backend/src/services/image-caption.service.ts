/**
 * Image Caption Service
 * Generates short captions for guest/host images using gpt-5-nano vision.
 * Runs fire-and-forget — updates message content so conversation history
 * shows "[Image: broken chair]" instead of blank lines.
 */

import OpenAI from 'openai';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { assertPublicHttpsUrl } from '../lib/url-safety';

const CAPTION_MODEL = 'gpt-5-nano';

const CAPTION_PROMPT = `Describe this image in 3-5 words for a property manager context. Be specific and concise.
Examples: "passport photo", "broken chair", "stain on couch", "bathroom leak", "guest selfie", "marriage certificate", "dirty towels", "kitchen appliance", "building exterior", "booking confirmation screenshot".
Output ONLY the short description, nothing else.`;

/**
 * Cap on how many images we'll caption in one message. Vision calls cost
 * ~$0.0001 each at low detail, so this is mostly a guard against absurd
 * spam (guest dumping 50 photos). Anything past the cap is bucketed.
 */
const MAX_CAPTIONS_PER_MESSAGE = 6;

/**
 * Caption images on a message and update its content. Fire-and-forget.
 *
 * Per-image captioning is critical for the document-checklist agent:
 * when a guest sends 3 passport photos in a single message, the model
 * needs to see three distinct "passport photo" entries in conversation
 * history so it calls mark_document_received three times (once per
 * passport). Prior to 2026-05-15 we captioned only the first image and
 * emitted a single bucketed tag (`[3 images: passport photo]`), which
 * collapsed three deliveries into one and undercounted the checklist.
 */
export async function captionMessageImages(
  messageId: string,
  imageUrls: string[],
  existingContent: string,
  prisma: PrismaClient,
): Promise<void> {
  if (!imageUrls.length) return;
  if (!process.env.OPENAI_API_KEY) return;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const toCaption = imageUrls.slice(0, MAX_CAPTIONS_PER_MESSAGE);
  const overflow = imageUrls.length - toCaption.length;

  try {
    const captions = await Promise.all(toCaption.map((url) => captionOne(openai, url)));
    const lines: string[] = [];
    captions.forEach((caption, idx) => {
      const label = toCaption.length === 1 ? 'Image' : `Image ${idx + 1}`;
      lines.push(`[${label}: ${caption}]`);
    });
    if (overflow > 0) {
      lines.push(`[+${overflow} more image${overflow === 1 ? '' : 's'} not captioned]`);
    }
    const tag = lines.join('\n');
    const updatedContent = existingContent ? `${existingContent}\n${tag}` : tag;
    await prisma.message.update({
      where: { id: messageId },
      data: { content: updatedContent },
    });
    console.log(
      `[ImageCaption] Captioned message ${messageId} (${toCaption.length}/${imageUrls.length} images): ${captions.join(' | ')}`,
    );
  } catch (err) {
    console.warn(`[ImageCaption] Failed to caption message ${messageId}:`, err);
  }
}

/**
 * Caption a single image. Returns either the model's caption or a
 * graceful fallback ("image") so the per-message Promise.all never
 * rejects on a single bad URL.
 */
async function captionOne(openai: OpenAI, url: string): Promise<string> {
  try {
    // 2026-05-15 (auto-review F3): guest-uploaded image URLs flow
    // through here as-is. Without this guard a crafted attachment
    // pointing at an internal IP / cloud metadata endpoint would be
    // fetched server-side and surfaced to OpenAI vision.
    await assertPublicHttpsUrl(url);
    const imgRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'GuestPilot/2.0' },
    });
    const base64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');
    const ct = (imgRes.headers['content-type'] || 'image/jpeg') as string;
    let mimeType = 'image/jpeg';
    if (ct.includes('png')) mimeType = 'image/png';
    else if (ct.includes('gif')) mimeType = 'image/gif';
    else if (ct.includes('webp')) mimeType = 'image/webp';

    const response = await openai.responses.create({
      model: CAPTION_MODEL,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: CAPTION_PROMPT },
            { type: 'input_image', image_url: `data:${mimeType};base64,${base64}`, detail: 'low' as const },
          ],
        },
      ],
      max_output_tokens: 30,
    });
    return ((response as any).output_text || '').trim() || 'image';
  } catch (err) {
    console.warn(`[ImageCaption] caption-one failed for ${url.slice(0, 80)}:`, err instanceof Error ? err.message : err);
    return 'image';
  }
}
