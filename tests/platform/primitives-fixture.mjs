import { launchFixture, firstKey, secondKey } from './fixture.mjs';

const editor = `<!doctype html><html lang="en"><body>
<div role="toolbar" aria-label="Editor"><button>Frame</button><button id="select">Select</button></div>
<button id="upload">Upload image</button><input type="file" hidden accept="image/png,image/jpeg">
<img id="preview" width="40" height="40"><div role="treeitem" id="layer">Initial layer</div>
<canvas width="1200" height="600"></canvas><p role="status">All changes saved</p>
<script>
window.events=[];window.chooserTriggers=0;window.uploads=[];
for(const type of ['mousedown','mouseup','mousemove','click'])document.addEventListener(type,e=>{
  window.events.push({type,shift:e.shiftKey,alt:e.altKey,control:e.ctrlKey,meta:e.metaKey,buttons:e.buttons});
});
document.querySelector('#upload').onclick=()=>{window.chooserTriggers++;document.querySelector('input').click()};
document.querySelector('input').onchange=async e=>{
  const file=e.target.files[0],bytes=await file.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const img=document.querySelector('#preview'),url=URL.createObjectURL(file);img.src=url;await img.decode();URL.revokeObjectURL(url);
  window.uploads.push({name:file.name,type:file.type,size:file.size,hash,width:img.naturalWidth,height:img.naturalHeight});
  document.querySelector('#layer').textContent=file.name;
};
</script></body></html>`;

export function launchPrimitives(profile, options) {
  return launchFixture(profile, options, route => {
    const url = new URL(route.request().url());
    if ([`/design/${firstKey}`, `/design/${secondKey}`].includes(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: editor });
    }
    if (url.pathname === '/files/recents' || url.pathname === '/login') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<label>Email<input aria-label="Email"></label>' });
    }
    return route.abort('blockedbyclient');
  });
}
