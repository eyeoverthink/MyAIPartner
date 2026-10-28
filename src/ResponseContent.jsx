import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const footnoteId = value => typeof value === 'string' && /^user-content-fn(?:ref)?-[a-z0-9_-]+$/i.test(value) ? value : undefined;

// Deliberately narrower than Markdown's default URL policy: no local paths,
// credentials, executable schemes, browser-relative URLs or invisible controls.
export function safeResponseHref(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('#') && footnoteId(value.slice(1))) return value;
  if (!/^https?:\/\//i.test(value) || /[\\\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

// Called only by the Copy button. Failure stays visible instead of pretending
// copying worked or attempting a background clipboard/DOM fallback.
export async function copyResponseCode(text, clipboard) {
  try {
    const target = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard;
    if (typeof text !== 'string' || typeof target?.writeText !== 'function') {
      return { ok: false, message: 'Clipboard unavailable. Select the code and copy it manually.' };
    }
    await target.writeText(text);
    return { ok: true, message: 'Code copied.' };
  } catch {
    return { ok: false, message: 'Could not copy. Select the code and copy it manually.' };
  }
}

const containsImage = node => node?.tagName === 'img' || Boolean(node?.children?.some(containsImage));

function ResponseLink({ href, id, title, children, node }) {
  const safe = safeResponseHref(href);
  if (!safe) return <span className="response-link-unavailable">{children}</span>;
  const external = !safe.startsWith('#');
  const anchor = label => <a href={safe} id={footnoteId(id)} title={title}
    target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
    referrerPolicy={external ? 'no-referrer' : undefined}>{label}</a>;
  // An authored image may itself be a Markdown link. Keep both destinations
  // explicit without nesting anchors around the image's controlled link.
  return containsImage(node)
    ? <span className="response-linked-image">{children} {anchor('Open linked destination')}</span>
    : anchor(children);
}

function ImageReference({ src, alt }) {
  const href = safeResponseHref(src);
  const label = alt || 'Image reference';
  return <span className="response-image-reference">
    <span className="response-image-label">Image: {label}</span>
    {href && !href.startsWith('#')
      ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open image link</a>
      : <span className="response-image-unavailable">Image link unavailable</span>}
    <span className="response-image-note">Not loaded automatically</span>
  </span>;
}

function codeFacts(node) {
  const code = node?.children?.find(child => child.type === 'element' && child.tagName === 'code');
  const classes = Array.isArray(code?.properties?.className) ? code.properties.className : [];
  const language = classes.map(value => /^language-([a-z0-9_+#.-]{1,40})$/i.exec(value)?.[1]).find(Boolean) || '';
  const text = (code?.children || []).filter(child => child.type === 'text').map(child => child.value).join('');
  return { text, language };
}

function CodeBlock({ node }) {
  const { text, language } = codeFacts(node);
  const [state, setState] = useState({ status: 'idle', message: '' });
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setState({ status: 'idle', message: '' });
    return () => { generation.current += 1; };
  }, [text]);

  async function copy() {
    const current = generation.current;
    setState({ status: 'copying', message: '' });
    const result = await copyResponseCode(text);
    if (current === generation.current) setState({ status: result.ok ? 'copied' : 'error', message: result.message });
  }

  return <div className="response-code-block">
    <div className="response-code-toolbar">
      <span className="response-code-language">{language || 'Code'}</span>
      <button type="button" className="response-code-copy" onClick={copy} disabled={state.status === 'copying'}
        aria-label="Copy code">{state.status === 'copying' ? 'Copying…' : state.status === 'copied' ? 'Copied' : 'Copy code'}</button>
    </div>
    <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code block'}><code className={language ? `language-${language}` : undefined}>{text}</code></pre>
    <span className={`response-code-status${state.status === 'error' ? ' response-code-error' : ''}`} role="status" aria-live="polite">{state.message}</span>
  </div>;
}

function ResponseTable({ children }) {
  return <div className="response-table-scroll" role="region" aria-label="Response table" tabIndex={0}>
    <table>{children}</table>
  </div>;
}

const components = { a: ResponseLink, img: ImageReference, pre: CodeBlock, table: ResponseTable };
const plugins = [remarkGfm];

export function ResponseContent({ text }) {
  return <div className="response-content">
    <Markdown skipHtml remarkPlugins={plugins} components={components} urlTransform={url => safeResponseHref(url) || ''}>
      {typeof text === 'string' ? text : ''}
    </Markdown>
  </div>;
}

export default ResponseContent;
