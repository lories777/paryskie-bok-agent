import { spawn } from 'node:child_process';
/** Publiczne materiały sklepu, bez sesji klienta, zapisów i dowolnego dostępu do sieci. */
const ORIGIN = 'https://paryskie.pl';
const MAX_BYTES = 2_000_000;
export function publicSiteUrl(path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /[%\\?#\s]/u.test(path)) throw Error('PUBLIC_PATH_INVALID');
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || !/^\/[a-zA-Z0-9_./-]*$/.test(path)
    || /(?:^|\/)(?:wp-admin|wp-json|wp-login|xmlrpc|koszyk|cart|checkout|zamowienie|moje-konto|my-account)(?:[/.]|$)/i.test(url.pathname)
    || /\.(?:php|json|xml)$/i.test(url.pathname)) throw Error('PUBLIC_PATH_INVALID');
  return url;
}
function decode(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
    const n = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1),16) : Number(code);
    return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, key: string) => ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[key]!));
}
export function publicPageText(html: string) {
  const clean=html.replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  const title=decode(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'Paryskie').trim();
  const main=clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]??clean;
  const links=[...main.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(m=>{
    try {const url=new URL(decode(m[1]!),ORIGIN);publicSiteUrl(url.pathname);if(url.origin!==ORIGIN||url.search||url.hash)return [];
      const label=decode(m[2]!.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
      return label ? [{title:label.slice(0,160),path:url.pathname}] : [];
    } catch{return [];}
  });
  const text=decode(main.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi,' $1 ')
    .replace(/<\/(?:p|div|li|h[1-6]|section|tr)>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,' '))
    .split('\n').map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
  return {title,text:text.slice(0,22000),truncated:text.length>22000,links:[...new Map(links.map(l=>[l.path,l])).values()].sort((a,b)=>Number(/regulamin|promocj|zwrot|dostaw/i.test(b.title+b.path))-Number(/regulamin|promocj|zwrot|dostaw/i.test(a.title+a.path))).slice(0,80)};
}
export async function readPublicSite(path: string, fetcher: typeof fetch=fetch) {
  let url=publicSiteUrl(path);
  for(let hop=0;hop<4;hop++) {
    const res=await fetcher(url,{method:'GET',redirect:'manual',headers:{accept:'text/html','user-agent':'Paryskie-BOK/1.0'},signal:AbortSignal.timeout(20_000)});
    if([301,302,303,307,308].includes(res.status)) {
      const target=new URL(res.headers.get('location')??'',url);
      if(target.origin!==ORIGIN||target.search||target.hash)throw Error('PUBLIC_REDIRECT_INVALID');
      url=publicSiteUrl(target.pathname);continue;
    }
    if(!res.ok)throw Error('PUBLIC_READ_FAILED');
    const type=res.headers.get('content-type')??'';
    if((!type.includes('text/html')&&!type.includes('application/pdf'))||!res.body)throw Error('PUBLIC_CONTENT_INVALID');
    const reader=res.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>MAX_BYTES)throw Error('PUBLIC_PAGE_TOO_LARGE');chunks.push(part.value);}}
    finally {await reader.cancel().catch(()=>undefined);}
    const bytes=Buffer.concat(chunks);
    const page=type.includes('application/pdf')?await publicPdfText(bytes):publicPageText(bytes.toString('utf8'));
    return {source:url.href,checkedAt:new Date().toISOString(),untrusted:true,...page};
  }
  throw Error('PUBLIC_REDIRECT_LIMIT');
}

async function publicPdfText(bytes: Buffer) {
  const text=await new Promise<string>((resolve,reject)=>{
    const child=spawn(process.env.BOK_PUBLIC_PDFTOTEXT_PATH || 'pdftotext',['-layout','-','-'],{stdio:['pipe','pipe','ignore']});
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('PUBLIC_PDF_TIMEOUT'));},10_000);
    const parts:Buffer[]=[];let size=0;
    child.on('error',()=>{clearTimeout(timeout);reject(Error('PUBLIC_PDF_UNAVAILABLE'));});
    child.stdout.on('data',(part:Buffer)=>{size+=part.length;if(size>200_000){child.kill('SIGKILL');reject(Error('PUBLIC_PDF_TOO_LARGE'));}else parts.push(part);});
    child.on('close',code=>{clearTimeout(timeout);if(code===0)resolve(Buffer.concat(parts).toString('utf8'));else reject(Error('PUBLIC_PDF_INVALID'));});
    child.stdin.on('error',()=>undefined);child.stdin.end(bytes);
  });
  return {title:'Dokument Paryskie',text:text.slice(0,22000),truncated:text.length>22000,links:[]};
}
