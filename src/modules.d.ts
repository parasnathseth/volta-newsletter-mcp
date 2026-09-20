// Wrangler bundles .html files as text modules.
declare module '*.html' {
  const content: string;
  export default content;
}
