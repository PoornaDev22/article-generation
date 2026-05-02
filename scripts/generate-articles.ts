import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface GeminiResponse { candidates?: Array<{ content: { parts: Array<{ text: string }> } }>; [key: string]: any }
interface GeminiError { error: { message: string } }

async function generateArticleWithKey(keyword: string): Promise<{ content: string; category: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // Step 1: Title
  const titleRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Generate a compelling article title for: "${keyword}". Return ONLY the title, no quotes.` }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 100 }
    })
  });
  const titleData: GeminiResponse = await titleRes.json();
  let title = keyword;
  const t = titleData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (t) title = t.replace(/^["']|["']$/g, '');

  // Step 2: Article
  const articleRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Write a 400-800 word article titled "${title}" about "${keyword}". Use markdown. Start with # heading. Use ## for subheadings.` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    })
  });
  const articleData: GeminiResponse | GeminiError = await articleRes.json();
  if (!articleRes.ok || 'error' in articleData) throw new Error((articleData as GeminiError).error?.message || 'Gemini failed');
  const content = (articleData as GeminiResponse).candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content || !content.trim().startsWith('# ')) throw new Error('Invalid content format');

  // Step 3: Category
  const catRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Categorize "${title}" into ONE of: Technology, Politics, Sports, Lifestyle, Health, Travel, Financial, Entertainment, General. Reply with ONLY the category name.` }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 20 }
    })
  });
  const catData: GeminiResponse = await catRes.json();
  let category = 'General';
  const ct = catData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (ct) {
    const valid = ['Technology', 'Politics', 'Sports', 'Lifestyle', 'Health', 'Travel', 'Financial', 'Entertainment'];
    const found = valid.find(c => ct.toLowerCase().includes(c.toLowerCase()));
    if (found) category = found;
  }

  return { content, category };
}

async function fetchTrendingKeywords(): Promise<string[]> {
  const url = `https://serpapi.com/search.json?engine=google_trends_trending_now&geo=US&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI failed: ${res.status}`);
  const data: any = await res.json();
  return (data.trending_searches || [])
    .map((item: any) => item.query || item.title)
    .filter((q: any) => q?.trim())
    .slice(0, 20);
}

async function fetchGoogleImage(keyword: string): Promise<string | null> {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_CSE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(keyword)}&searchType=image&num=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.items?.[0]?.link || null;
  } catch { return null; }
}

function parseContent(markdown: string, fallback: string): { title: string; blocks: any[] } {
  const lines = markdown.split('\n');
  let title = fallback;
  const blocks: any[] = [];
  let titleFound = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!titleFound && trimmed.startsWith('# ')) {
      title = trimmed.replace('# ', '');
      titleFound = true;
      blocks.push({ type: 'heading', level: 1, children: [{ type: 'text', text: title }] });
    } else if (trimmed.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, children: [{ type: 'text', text: trimmed.replace('## ', '') }] });
    } else if (trimmed.startsWith('- ')) {
      blocks.push({ type: 'list-item', children: [{ type: 'text', text: trimmed.replace('- ', '') }] });
    } else {
      blocks.push({ type: 'paragraph', children: [{ type: 'text', text: trimmed }] });
    }
  }
  return { title, blocks };
}

function generateSlug(title: string, fallback: string): string {
  const base = (title || fallback).toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
  return `${base}-${Date.now()}`;
}

async function main() {
  console.log('Starting article generation...');
  const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=800&h=400&fit=crop';

  // Get already used keywords
  const { data: existing } = await supabase.from('articles').select('keyword');
  const usedKeywords = new Set((existing || []).map((a: any) => a.keyword?.toLowerCase().trim()));
  console.log(`Used keywords: ${usedKeywords.size}`);

  // Fetch trending
  const allKeywords = await fetchTrendingKeywords();
  const available = allKeywords.filter(k => !usedKeywords.has(k.toLowerCase().trim())).slice(0, 10);
  console.log(`Available keywords: ${available.length}`);

  let count = 0;
  for (const keyword of available) {
    if (count >= 5) break;
    try {
      console.log(`Generating: ${keyword}`);
      const imageKeyword = keyword.replace(/[^\w\s]/g, '').split(' ').filter(w => w.length > 3).slice(0, 3).join(' ');
      const [articleResult, imageUrl] = await Promise.all([
        generateArticleWithKey(keyword),
        fetchGoogleImage(imageKeyword)
      ]);
      const { title, blocks } = parseContent(articleResult.content, keyword);
      const slug = generateSlug(title, keyword);
      const { error } = await supabase.from('articles').insert({
        title,
        content: JSON.stringify(blocks),
        keyword,
        category: articleResult.category,
        pubstatus: 'published',
        pubat: new Date().toISOString(),
        slug,
        imageUrl: imageUrl || FALLBACK_IMAGE,
      });
      if (error) throw new Error(error.message);
      console.log(`✓ Saved: ${title}`);
      count++;
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`✗ Failed: ${keyword} —`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. Generated ${count} articles.`);
}

main();
