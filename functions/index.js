/* Heartthrob — AI backend for "Shoot Your Shot".
   ssProfiles — generates all dating profiles for a game in one Claude call.
   ssJudge    — "she" reads every pickup line, picks a winner, roasts the worst,
                and her spoken reply is voiced via ElevenLabs -> Storage mp3.
   Keys live in functions/.env (gitignored). With no keys, both functions return
   demo flags and the client falls back to its local mock — game never wedges. */
const { onCall } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

const ANTHROPIC_KEY = () => process.env.ANTHROPIC_KEY || '';
const ELEVENLABS_KEY = () => process.env.ELEVENLABS_KEY || '';
const ELEVENLABS_VOICE = () => process.env.ELEVENLABS_VOICE || 'EXAVITQu4vr4xnSDxMaL';   // "Sarah"
const CLAUDE_MODEL = 'claude-sonnet-5';

async function claude(system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens || 600,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j.content || []).map(b => b.text || '').join('');
}

const firstJson = (text, open, close) => {
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a < 0 || b <= a) throw new Error('no json in model output');
  return JSON.parse(text.slice(a, b + 1));
};

async function ttsToStorage(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE()}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY(), 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 }
    })
  });
  if (!r.ok) throw new Error('elevenlabs ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const path = `tts/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(buf, { contentType: 'audio/mpeg', public: true });
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

/* ---- all profiles for a whole game, one call ---- */
exports.ssProfiles = onCall({ region: 'us-central1', timeoutSeconds: 40 }, async (req) => {
  if (!ANTHROPIC_KEY()) return { profiles: null, demo: true };
  try {
    const count = Math.min(8, Math.max(3, (req.data || {}).count || 5));
    const text = await claude(
      'You write dating profiles for a college party game played by 4-6 guys in their 20s. ' +
      'Profiles are flirty, witty, savage but not cruel, strictly PG-13. Vary the archetypes ' +
      '(gym girl, nurse, lawyer, party girl, teacher, influencer, barista, film snob…). ' +
      'Return ONLY a JSON array — no markdown, no commentary.',
      `Write ${count} distinct dating profiles as a JSON array. Each object has EXACTLY these keys:\n` +
      `"name" (common American female first name, all different), "age" (21-29), "job" (3-6 words, may be funny), ` +
      `"vibe" (one short line), "looking_for" (short), "dealbreaker" (short, funny), ` +
      `"greeting" (one flirty, challenging sentence she says to the players, max 15 words).`,
      1400);
    const arr = firstJson(text, '[', ']');
    return { profiles: arr.slice(0, count) };
  } catch (e) {
    console.error('ssProfiles failed', e);
    return { profiles: null, demo: true };
  }
});

/* ---- she reads every line, picks a winner, roasts the worst ---- */
exports.ssJudge = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() || !Array.isArray(d.lines) || !d.lines.length) return { demo: true };
  const RULES = {
    standard: 'Judge normally: reward charm, wit, and specificity to her profile.',
    redflag: 'Her profile has red flags. Reward lines that cleverly address them or weaponize them.',
    constraint: `HARD RULE for every line: ${d.constraint}. A line that breaks the rule CANNOT win — pick the best rule-follower, and roast a rule-breaker.`,
    finale: 'Finale round: this is their last impression. Her response should also nod to the whole night of lines.'
  };
  const p = d.profile || {};
  try {
    const list = d.lines.map(l => `- pid "${l.pid}" (${l.name}): "${l.text}"`).join('\n');
    const text = await claude(
      `You are ${p.name}, ${p.age}, ${p.job}. ${p.vibe}. You are looking for: ${p.looking_for}. ` +
      `Dealbreaker: ${p.dealbreaker}. A group of guys at a party each typed you one pickup line. ` +
      'You are witty, flirty, savage but not cruel, strictly PG-13. Return ONLY JSON — no markdown.',
      `${RULES[d.roundType] || RULES.standard}\n\nThe lines:\n${list}\n\n` +
      'Return JSON with EXACTLY these keys:\n' +
      '"winnerPid": pid of the best line (copy the pid EXACTLY as given),\n' +
      '"response": your spoken reply to the winner — 1-3 sentences, in character, reference something SPECIFIC from their line, address them by first name,\n' +
      '"roastPid": pid of the worst line (different from the winner if possible),\n' +
      '"roast": one savage sentence about why that line failed, address them by first name.',
      500);
    const j = firstJson(text, '{', '}');
    let audioUrl = null, roastAudioUrl = null;
    if (ELEVENLABS_KEY()) {
      if (j.response) { try { audioUrl = await ttsToStorage(j.response); } catch (e) { console.error('tts failed (text-only fallback)', e); } }
      if (j.roast) { try { roastAudioUrl = await ttsToStorage(j.roast); } catch (e) { console.error('roast tts failed', e); } }
    }
    return {
      winnerPid: j.winnerPid,
      winnerText: ((d.lines.find(l => l.pid === j.winnerPid)) || {}).text || null,
      response: j.response || null,
      roastPid: j.roastPid || null,
      roast: j.roast || null,
      audioUrl,
      roastAudioUrl
    };
  } catch (e) {
    console.error('ssJudge failed', e);
    return { demo: true };
  }
});
