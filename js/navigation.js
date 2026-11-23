const route=()=>location.hash.slice(1)||'home';
export function navigation(render){
 if(!history.state?.soundify) history.replaceState({soundify:true,i:0,max:0},'');
 let furthest=history.state.max;
 const update=()=>{
  const i=history.state?.i??0;
  document.querySelector('[data-act="back"]').disabled=i===0;
  document.querySelector('[data-act="forward"]').disabled=i>=furthest;
  render(route());
  document.querySelector('.workspace').scrollTop=0;
 };
 window.addEventListener('popstate',update);
 update();
 return (dest)=>{
  if(dest==='back') return history.back();
  if(dest==='forward') return history.forward();
  if(route()===dest) return;
  const i=(history.state?.i??0)+1;
  furthest=i;
  history.pushState({soundify:true,i,max:i},'',`#${dest}`);
  update();
 };
}
