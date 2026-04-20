import { translationService } from '../src/services/translation.service';

async function main() {
  try {
    const result = await translationService.translate(
      'Hi Omar! Wat is de toegangscode van het appartement?',
      { targetLang: 'en' }
    );
    console.log('SUCCESS:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('FAILED:', err?.message, 'status:', err?.response?.status, 'data:', typeof err?.response?.data === 'string' ? err.response.data.slice(0, 300) : err?.response?.data);
  }
}
main();
