import MarkdownIt from 'markdown-it';

let md: any = null;

/** Safe markdown -> HTML (raw HTML disabled, so chat content can never inject markup). */
export function renderMarkdown(text: string): string {
  if (!md) {
    md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
    const defaultRender = md.renderer.rules.link_open || ((tokens: any, idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens: any, idx: number, options: any, env: any, self: any) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultRender(tokens, idx, options, env, self);
    };
  }
  return md.render(text);
}
