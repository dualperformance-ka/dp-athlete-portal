export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  const { endpoint, body } = req.body;
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  }
  try {
    const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    
    // Map Notion properties to clean object while preserving original structure
    if (data.results) {
      data.results = data.results.map(page => {
        const props = page.properties || {};
        
        // Extract mapped properties
        const mapped = {
          runningSession: props['Running Session']?.rich_text?.[0]?.plain_text || '',
          runDetails: props['Run Details']?.rich_text?.[0]?.plain_text || '',
        };
        
        // Return original page with mapped properties added at top level
        return {
          ...page,
          ...mapped
        };
      });
    }
    
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
