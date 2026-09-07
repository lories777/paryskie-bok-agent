import { describe,it,expect,vi } from 'vitest';
import {publicSiteUrl,publicPageText,readPublicSite} from '../src/public-site.js';
describe('public store research',()=>{
  it.each(['https://evil.test','//evil.test','/wp-admin','/wp-json/orders','/koszyk/','/?add-to-cart=1','/%2e%2e/wp-admin','/foo/../wp-admin','/wp-login.php'])('rejects private or mutating target %s',path=>expect(()=>publicSiteUrl(path)).toThrow());
  it('keeps current and expired terms; removes scripts and exposes allowed policy links',()=>{
    const result=publicPageText('<main><h1>Promocje</h1><p>Kod FESTIVAL — promocja zakończona</p><a href="/regulamin">Warunki</a><a href="https://evil.test/">bad</a><script>steal()</script></main>');
    expect(result.text).toContain('promocja zakończona');expect(result.text).not.toContain('steal');expect(result.links).toEqual([{title:'Warunki',path:'/regulamin'}]);
  });
  it('never follows an off-site redirect or sends credentials',async()=>{
    const fake=vi.fn().mockResolvedValue(new Response('',{status:302,headers:{location:'https://evil.test/'}}));
    await expect(readPublicSite('/aktualne-promocje',fake)).rejects.toThrow('PUBLIC_REDIRECT_INVALID');
    expect(fake).toHaveBeenCalledTimes(1);expect(fake.mock.calls[0]![1]).toMatchObject({method:'GET',redirect:'manual'});
    expect(fake.mock.calls[0]![1].headers).not.toHaveProperty('authorization');
  });
  it('reports read time, original source and bounded text',async()=>{
    const fake=vi.fn().mockResolvedValue(new Response('<main><p>Dostawa</p></main>',{headers:{'content-type':'text/html'}}));
    expect(await readPublicSite('/dostawa',fake)).toMatchObject({source:'https://paryskie.pl/dostawa',text:'Dostawa',untrusted:true,truncated:false});
  });
});
