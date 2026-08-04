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

async function ttsToStorage(text, voiceId) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || ELEVENLABS_VOICE()}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY(), 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
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
      'Vary the jobs and education WIDELY across the set — trades, tech, military, service industry, creative, medical, corporate, gig work; never repeat a job within a game, and do not default to nurse/teacher/trainer. ' +
      'Return ONLY a JSON array — no markdown, no commentary.',
      `Write ${count} distinct dating profiles as a JSON array. Each object has EXACTLY these keys:\n` +
      `"name" (common American female first name, all different), "age" (21-29), ` +
      `"job" (plain realistic job title, 1-4 words, NOT a joke — e.g. "ER Nurse", "Law Student"), ` +
      `"education" (short — e.g. "ASU", "Community College", "Trade School", "U of A"), ` +
      `"height" (written like 5\'4"), "location" (a neighborhood or area — e.g. "Old Town", "Downtown"), ` +
      `"prompts" (array of EXACTLY 2 objects {"label", "answer"} — label MUST be picked from this list: "My simple pleasures", "I want someone who", "Together, we could", "I'm known for", "Don't hate me if I", "The way to win me over", "Green flags I look for"; answer is 4-14 words, first person, specific, playful, sounds like a real 24-year-old wrote it, no cliches), ` +
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
    const hist = Array.isArray(d.history) && d.history.length
      ? 'Earlier tonight you judged: ' + d.history.map(h => `${h.winnerName} won over ${h.prof} with "${h.winnerText}"`).join('; ') + '. You may call back to these. '
      : '';
    // content blocks: every line WITH the guy's actual face attached
    const blocks = [{ type: 'text', text:
      `${RULES[d.roundType] || RULES.standard}\n\n` +
      'Each pickup line is followed by a photo of the guy who said it. You may reference his appearance in your response, roast, or verdicts.\n\n' }];
    d.lines.forEach(l => {
      blocks.push({ type: 'text', text: `pid "${l.pid}" (${l.name}): "${l.text}"` });
      const m2 = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(l.avatar || '');
      if (m2) blocks.push({ type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } });
    });
    blocks.push({ type: 'text', text:
      '\nReturn JSON with EXACTLY these keys:\n' +
      '"winnerPid": pid of the best line (copy the pid EXACTLY as given),\n' +
      '"response": your spoken reply to the winner — 1-3 sentences, in character, reference something SPECIFIC from their line, address them by first name,\n' +
      '"roastPid": pid of the worst line (different from the winner if possible),\n' +
      '"roast": one savage sentence about why that line failed, address them by first name,\n' +
      '"verdicts": object mapping EVERY non-winner pid to a 1-3 word verdict stamp (e.g. "desperate", "smooth", "restraining order", "too safe"),\n' +
      '"crowdDisagree": one savage sentence defending your pick if the whole room boos it — dismiss them all.' });
    const text = await claude(
      `You are ${p.name}, ${p.age}, ${p.job} from ${p.location}. ` +
      (p.prompts || []).map(pr => `On your dating profile, under "${pr.label}", you wrote: "${pr.answer}". `).join('') +
      hist +
      'A group of guys at a party each typed you one pickup line. ' +
      'You are witty, flirty, savage but not cruel, strictly PG-13. Return ONLY JSON — no markdown.',
      blocks, 700);
    const j = firstJson(text, '{', '}');
    let audioUrl = null, roastAudioUrl = null, disagreeAudioUrl = null;
    if (ELEVENLABS_KEY()) {   // all three voices fire in PARALLEL
      const jobs = [];
      if (j.response) jobs.push(ttsToStorage(j.response).then(u => { audioUrl = u; }).catch(e => console.error('tts failed', e)));
      if (j.roast) jobs.push(ttsToStorage(j.roast).then(u => { roastAudioUrl = u; }).catch(e => console.error('roast tts failed', e)));
      if (j.crowdDisagree) jobs.push(ttsToStorage(j.crowdDisagree).then(u => { disagreeAudioUrl = u; }).catch(e => console.error('disagree tts failed', e)));
      await Promise.all(jobs);
    }
    return {
      winnerPid: j.winnerPid,
      winnerText: ((d.lines.find(l => l.pid === j.winnerPid)) || {}).text || null,
      response: j.response || null,
      roastPid: j.roastPid || null,
      roast: j.roast || null,
      verdicts: j.verdicts || null,
      crowdDisagree: j.crowdDisagree || null,
      audioUrl,
      roastAudioUrl,
      disagreeAudioUrl
    };
  } catch (e) {
    console.error('ssJudge failed', e);
    return { demo: true };
  }
});

/* ---- Profile Review: a panel of three AI girls swipes on the guys' own profiles ---- */
exports.prJudge = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY()) return { demo: true };
  try {
    const name = d.name || 'this guy';
    const blocks = [{ type: 'text', text:
      `You are reviewing ${name}'s dating profile. His photos are attached, then his written answers.\n` +
      `Prompts: ${(d.prompts || []).map(pr => `"${pr.label}" -> "${pr.answer}"`).join('; ')}\n` +
      (d.bio ? `Bio: "${d.bio}"\n` : '') }];
    (d.photos || []).slice(0, 3).forEach(u => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(u || '');
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    });
    blocks.push({ type: 'text', text:
      '\nReturn JSON with EXACTLY these keys: "romantic", "savage", "unhinged" — each an object ' +
      '{"swipe": "left" or "right", "comment": your spoken verdict, 1-2 sentences}. ' +
      'Each comment MUST reference something SPECIFIC you see in his photos or answers. Address him by first name sometimes.' });
    const text = await claude(
      'You are THREE women on a party dating-profile review panel, judging one guy out loud while he squirms. ' +
      'ROMANTIC: hopeless romantic, generous, wants love to win — swipes right unless truly hopeless. ' +
      'SAVAGE: brutally honest with high standards — harsh on weak profiles but genuinely won over by good ones; a strong profile earns her right swipe roughly half the time. ' +
      'UNHINGED: chaotic, weird logic, unpredictable — swipes on vibes nobody can follow. ' +
      'Every swipe MUST reflect the actual quality of THIS profile — not a fixed agenda. Strictly PG-13. Return ONLY JSON — no markdown.',
      blocks, 800);
    const j = firstJson(text, '{', '}');
    const VOICES = {
      romantic: process.env.ELEVENLABS_VOICE_ROMANTIC || 'EXAVITQu4vr4xnSDxMaL',   // Sarah
      savage: process.env.ELEVENLABS_VOICE_SAVAGE || 'cgSgspJ2msm6clMCkdW9',        // Jessica
      unhinged: process.env.ELEVENLABS_VOICE_UNHINGED || 'pFZP5JQG7iQjIQuC4Bku'     // Lily
    };
    const out = {}, jobs = [];
    for (const persona of ['romantic', 'savage', 'unhinged']) {
      const v = j[persona] || {};
      out[persona] = { swipe: v.swipe === 'left' ? 'left' : 'right', comment: v.comment || '', audioUrl: null };
      if (ELEVENLABS_KEY() && out[persona].comment) {
        jobs.push(ttsToStorage(out[persona].comment, VOICES[persona])
          .then(u => { out[persona].audioUrl = u; })
          .catch(e => console.error(persona + ' tts failed', e)));
      }
    }
    await Promise.all(jobs);   // all three voices in parallel
    return { verdicts: out };
  } catch (e) {
    console.error('prJudge failed', e);
    return { demo: true };
  }
});

/* ---- Profile Review finale: the panel argues it out and crowns a champion ---- */
exports.prDeliberate = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() || !Array.isArray(d.contenders)) return { demo: true };
  try {
    const sheet = d.contenders.map(c =>
      `- pid "${c.pid}" (${c.name}): ${c.rights}/3 right swipes. Prompts: ${(c.prompts || []).map(pr => `"${pr.label}" -> "${pr.answer}"`).join('; ')}.` +
      (c.bio ? ` Bio: "${c.bio}".` : '') +
      ` Panel said — Romantic: "${(c.comments || {}).romantic || ''}", Savage: "${(c.comments || {}).savage || ''}", Unhinged: "${(c.comments || {}).unhinged || ''}"`
    ).join('\n');
    const text = await claude(
      'You are the SAME three women from the review panel (ROMANTIC, SAVAGE, UNHINGED), now arguing amongst yourselves to crown one champion of the night. ' +
      'You bicker, interrupt, reference your own earlier verdicts and specific profile details, then agree on ONE winner. ' +
      'Debate lines are 1-2 sentences each, strictly PG-13, in character. Return ONLY JSON — no markdown.',
      'The contenders:\n' + sheet + '\n\n' +
      'Return JSON with EXACTLY these keys:\n' +
      '"debate": array of 6-9 objects {"who": "romantic"|"savage"|"unhinged", "text": spoken line} — a real argument that builds to a decision,\n' +
      '"winnerPid": pid of the champion (copy EXACTLY),\n' +
      '"crownLine": one sentence crowning him, spoken by whichever persona championed him.',
      1100);
    const j = firstJson(text, '{', '}');
    const VOICES = {
      romantic: process.env.ELEVENLABS_VOICE_ROMANTIC || 'EXAVITQu4vr4xnSDxMaL',
      savage: process.env.ELEVENLABS_VOICE_SAVAGE || 'cgSgspJ2msm6clMCkdW9',
      unhinged: process.env.ELEVENLABS_VOICE_UNHINGED || 'pFZP5JQG7iQjIQuC4Bku'
    };
    const jobs = [];
    const debate = (Array.isArray(j.debate) ? j.debate : []).slice(0, 9).map(line => {
      const who = ['romantic', 'savage', 'unhinged'].includes(line.who) ? line.who : 'savage';
      const out = { who, text: line.text || '', audioUrl: null };
      if (ELEVENLABS_KEY() && out.text) {
        jobs.push(ttsToStorage(out.text, VOICES[who]).then(u => { out.audioUrl = u; }).catch(e => console.error('debate tts failed', e)));
      }
      return out;
    });
    const crown = { text: j.crownLine || '', audioUrl: null };
    if (ELEVENLABS_KEY() && crown.text) {
      jobs.push(ttsToStorage(crown.text, VOICES.romantic).then(u => { crown.audioUrl = u; }).catch(e => console.error('crown tts failed', e)));
    }
    await Promise.all(jobs);
    return { debate, winnerPid: j.winnerPid || null, crownLine: crown.text, crownAudioUrl: crown.audioUrl };
  } catch (e) {
    console.error('prDeliberate failed', e);
    return { demo: true };
  }
});
