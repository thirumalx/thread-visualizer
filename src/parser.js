export function parseJBossCLIFormat(contents) {
  try {
    // If it's already standard JSON, this will work.
    return JSON.parse(contents);
  } catch (e) {
    // It's likely the JBoss CLI custom format, let's clean it up.
    
    // Replace "=>" with ":"
    let cleaned = contents.replace(/=>/g, ':');
    
    // Replace "undefined" with "null" (JBoss CLI uses undefined for missing values)
    cleaned = cleaned.replace(/\bundefined\b/g, 'null');
    
    // Replace long integers like 302L with 302
    // We match a number followed by L, not enclosed in quotes.
    // A simple approach is replacing (\d+)L with $1, provided it's followed by a comma or newline.
    cleaned = cleaned.replace(/(\d+)L\b/g, '$1');
    
    return JSON.parse(cleaned);
  }
}
