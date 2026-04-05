/**
 * Image Caption Service
 * Generates short captions for guest/host images using gpt-5-nano vision.
 * Runs fire-and-forget — updates message content so conversation history
 * shows "[Image: broken chair]" instead of blank lines.
 */

import OpenAI from 'openai';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const CAPTION_MODEL = 'gpt-5-nano';

const CAPTION_PROMPT = `Describe this image in 3-5 words for a property manager context. Be specific and concise.
Examples: "passport photo", "broken chair", "stain on couch", "bathroom leak", "guest selfie", "marriage certificate", "dirty towels", "kitchen appliance", "building exterior", "booking confirmation screenshot".
Output ONLY the short description, nothing else.`;

/**
 * Caption images on a message and update its content. Fire-and-forget.
 * Appends "[Image: caption]" to the message content for each image.
 */
export async function captionMessageImages(
  messageId: string,
  imageUrls: string[],
  existingContent: string,
  prisma: PrismaClient,
): Promise<void> {
  if (!imageUrls.length) return;
  if (!process.env.OPENAI_API_KEY) return;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Download first image only (caption the primary image — keeps cost minimal)
    const url = imageUrls[0];
    let base64: string;
    let mimeType = 'image/jpeg';
    try {
      const imgRes = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': 'GuestPilot/2.0' },
      });
      base64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');
      const ct = (imgRes.headers['content-type'] || 'image/jpeg') as string;
      if (ct.includes('png')) mimeType = 'image/png';
      else if (ct.includes('gif')) mimeType = 'image/gif';
      else if (ct.includes('webp')) mimeType = 'image/webp';
    } catch {
      console.warn(`[ImageCaption] Could not download image for captioning: ${url}`);
      // Still update content so history isn't blank
      const fallback = imageUrls.length === 1
        ? '[Image sent by guest]'
        : `[${imageUrls.length} images sent by guest]`;
      const updatedContent = existingContent ? `${existingContent}\n${fallback}` : fallback;
      await prisma.message.update({
        where: { id: messageId },
        data: { content: updatedContent },
      });
      return;
    }

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

    const caption = (response as any).output_text?.trim() || 'image';

    // Build the tag — if multiple images, note the count
    const tag = imageUrls.length === 1
      ? `[Image: ${caption}]`
      : `[${imageUrls.length} images: ${caption}]`;

    const updatedContent = existingContent ? `${existingContent}\n${tag}` : tag;
    await prisma.message.update({
      where: { id: messageId },
      data: { content: updatedContent },
    });
    console.log(`[ImageCaption] Captioned message ${messageId}: "${caption}"`);
  } catch (err) {
    console.warn(`[ImageCaption] Failed to caption message ${messageId}:`, err);
  }
}
