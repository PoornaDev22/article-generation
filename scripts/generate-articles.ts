import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // service role so it can write
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// --- Fetch trending keywords (paste your existing logic here) ---
async function fetchTrendingKeywords(): Promise<string[]> {
  const res = await fetch(
    'https://trends.google.com/trending/rss?geo=US',
  );
  const text = await res.text();
  // parse XML titles — quick regex approach
  const matches = [...text.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)];
  return matches.slice(0, 5).map(m => m[1]);
}

// --- Generate article with Gemini ---
async function generateArticle(keyword: string) {
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

  const prompt = `Write a detailed, engaging news article about: "${keyword}".
Return JSON with this exact shape:
{
  "title": "...",
  "slug": "url-friendly-slug",
  "category": "...",
  "content": "full article in markdown"
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const json = JSON.parse(text.replace(/```json|```/g, '').trim());
  return json;
}

// --- Check if article already exists ---
async function articleExists(keyword: string): Promise<boolean> {
  const { data } = await supabase
    .from('articles')
    .select('id')
    .eq('keyword', keyword)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// --- Main ---
async function main() {
  console.log('Fetching trending keywords...');
  const keywords = await fetchTrendingKeywords();
  console.log('Keywords:', keywords);

  for (const keyword of keywords) {
    if (await articleExists(keyword)) {
      console.log(`Skipping existing: ${keyword}`);
      continue;
    }

    try {
      console.log(`Generating article for: ${keyword}`);
      const article = await generateArticle(keyword);

      await supabase.from('articles').insert({
        title: article.title,
        slug: article.slug,
        keyword,
        category: article.category,
        content: article.content, // store as text or jsonb
        pubstatus: 'published',
        pubat: new Date().toISOString(),
      });

      console.log(`✓ Saved: ${article.title}`);
    } catch (err) {
      console.error(`✗ Failed for "${keyword}":`, err);
    }
  }

  console.log('Done.');
}

main();
