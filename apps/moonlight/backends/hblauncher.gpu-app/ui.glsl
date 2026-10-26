// Console UI: pages the host publishes into the two UI buffers, the cursor and the commands the
// console owns. Include after ring.glsl with uiWord() defined on the private memory; the compute
// shader defines UI_COMPUTE and includes hb.glsl first. Contract: research/moonlight-ui-design.md.
const uint UI_PAGE_MAGIC=0x47504248u;
const uint UI_HDR_EPOCH=1u,UI_HDR_SEQUENCE=2u,UI_HDR_FLAGS=3u,UI_HDR_ITEMS=4u,UI_HDR_TEXTS=5u,UI_HDR_IMAGES=6u;
const uint UI_HDR_BODY=7u,UI_HDR_BACKGROUND=8u,UI_HDR_HOME=9u,UI_HDR_CHECKSUM=10u;
const uint UI_ITEMS=16u,UI_TEXTS=272u,UI_IMAGES=656u,UI_TABLES_END=1024u,UI_BODY=1024u;
const uint UI_MAX_ITEMS=32u,UI_MAX_TEXTS=48u,UI_MAX_IMAGES=24u,UI_MAX_BODY=UI_PAGE_WORDS*4u-4096u;
const uint UI_FLAG_OVERLAY=1u,UI_FLAG_HIDE_CURSOR=2u;
const uint UI_ITEM_GREYED=1u,UI_ITEM_CURRENT=2u,UI_ITEM_ADJUSTABLE=4u,UI_ITEM_PENDING=8u;
const uint UI_OP_A=1u,UI_OP_B=2u,UI_OP_X=3u,UI_OP_Y=4u,UI_OP_ADJUST=5u,UI_OP_CHORD=6u;
const uint UI_CHORD_FRAMES=60u,UI_STICK_REPEAT=12u;

uint uiPageBase(uint page){return UI_BASE+page*UI_PAGE_WORDS;}
uint uiShownBase(){return uiPageBase(uiWord(CONTROL_UI_SHOWN)&1u);}
uint uiByte(uint base,uint offset){return (uiWord(base+offset/4u)>>((offset&3u)*8u))&255u;}
uvec4 uiRect(uint base,uint table,uint index,uint first){uint o=base+table+index*8u+first;return uvec4(uiWord(o),uiWord(o+1u),uiWord(o+2u),uiWord(o+3u));}
bool uiInside(vec2 p,uvec4 r){return p.x>=float(r.x)&&p.y>=float(r.y)&&p.x<float(r.x+r.z)&&p.y<float(r.y+r.w);}
vec4 uiColor(uint packed){return vec4(packed&255u,(packed>>8u)&255u,(packed>>16u)&255u,packed>>24u)/255.0;}
// The page replaces the video unless it is an overlay, which shows only while raised.
bool uiShowsPage(){
 if(uiWord(CONTROL_UI_MAGIC)!=UI_MAGIC||uiWord(CONTROL_UI_APPLIED)==0u)return false;
 return (uiWord(uiShownBase()+UI_HDR_FLAGS)&UI_FLAG_OVERLAY)==0u||uiWord(CONTROL_UI_OVERLAY)!=0u;
}

#ifdef UI_COMPUTE
bool uiRectOk(uvec4 r,uint maxW,uint maxH){return r.z>0u&&r.w>0u&&r.z<=maxW&&r.w<=maxH&&r.x+r.z<=1920u&&r.y+r.w<=1080u;}
// The checks ui-page.js validate() makes, on the buffer the host named.
bool uiValid(uint base,uint epoch,uint sequence){
 if(uiWord(base)!=UI_PAGE_MAGIC||uiWord(base+UI_HDR_EPOCH)!=epoch||uiWord(base+UI_HDR_SEQUENCE)!=sequence)return false;
 uint items=uiWord(base+UI_HDR_ITEMS),texts=uiWord(base+UI_HDR_TEXTS),images=uiWord(base+UI_HDR_IMAGES),body=uiWord(base+UI_HDR_BODY);
 if(items>UI_MAX_ITEMS||texts>UI_MAX_TEXTS||images>UI_MAX_IMAGES||body>UI_MAX_BODY)return false;
 if(uiWord(base+UI_HDR_HOME)>=max(items,1u))return false;
 uint checksum=2166136261u;
 for(uint w=0u;w<UI_HDR_CHECKSUM;w++)checksum=(checksum^uiWord(base+w))*16777619u;
 for(uint w=UI_ITEMS;w<UI_TABLES_END;w++)checksum=(checksum^uiWord(base+w))*16777619u;
 if(checksum!=uiWord(base+UI_HDR_CHECKSUM))return false;
 for(uint i=0u;i<items;i++)if(uiWord(base+UI_ITEMS+i*8u)==0u||!uiRectOk(uiRect(base,UI_ITEMS,i,1u),1920u,1080u))return false;
 for(uint i=0u;i<texts;i++){
  uvec4 r=uiRect(base,UI_TEXTS,i,0u);uint offset=uiWord(base+UI_TEXTS+i*8u+4u);
  if(!uiRectOk(r,1920u,96u)||(offset&3u)!=0u||offset+r.z*r.w>body)return false;
 }
 for(uint i=0u;i<images;i++){
  uvec4 r=uiRect(base,UI_IMAGES,i,0u);uint offset=uiWord(base+UI_IMAGES+i*8u+4u);
  if(!uiRectOk(r,320u,180u)||(offset&3u)!=0u||offset+r.z*r.w*4u>body||uiWord(base+UI_IMAGES+i*8u+5u)!=1u)return false;
 }
 return true;
}
uint uiItemId(uint base,uint index){return uiWord(base+UI_ITEMS+index*8u);}
uint uiItemFlags(uint base,uint index){return uiWord(base+UI_ITEMS+index*8u+5u);}
// A new page keeps the cursor on the item with the same id, else goes to the page's home.
void uiApply(){
 uint sequence=uiWord(CONTROL_UI_SEQUENCE),epoch=uiWord(CONTROL_UI_EPOCH),page=uiWord(CONTROL_UI_PAGE);
 if(uiWord(CONTROL_UI_MAGIC)!=UI_MAGIC||sequence==0u||sequence==uiWord(CONTROL_UI_APPLIED)||page>1u)return;
 uint base=uiPageBase(page);
 if(!uiValid(base,epoch,sequence))return;
 uint applied=uiWord(CONTROL_UI_APPLIED),shown=uiShownBase(),cursor=uiWord(base+UI_HDR_HOME);
 bool sameEpoch=applied!=0u&&uiWord(shown+UI_HDR_EPOCH)==epoch;
 if(sameEpoch){
  uint id=uiItemId(shown,min(uiWord(CONTROL_UI_CURSOR),UI_MAX_ITEMS-1u)),items=uiWord(base+UI_HDR_ITEMS);
  for(uint i=0u;i<items;i++)if(uiItemId(base,i)==id)cursor=i;
 }
 if((uiWord(base+UI_HDR_FLAGS)&UI_FLAG_OVERLAY)==0u||!sameEpoch)memory.words[CONTROL_UI_OVERLAY]=0u;
 memory.words[CONTROL_UI_CURSOR]=cursor;
 memory.words[CONTROL_UI_SHOWN]=page;
 memoryBarrierBuffer();
 memory.words[CONTROL_UI_APPLIED]=sequence;
}
// Args, then the op, then the sequence, so the host never pairs a new op with old args.
void uiCommand(uint op,uint item,uint value){
 memory.words[CONTROL_CMD_ITEM]=item;memory.words[CONTROL_CMD_VALUE]=value;
 memory.words[CONTROL_CMD_PAGE]=uiWord(CONTROL_UI_APPLIED);memory.words[CONTROL_CMD_EPOCH]=uiWord(CONTROL_UI_EPOCH);
 memoryBarrierBuffer();
 memory.words[CONTROL_CMD_OP]=op;
 memoryBarrierBuffer();
 uint sequence=uiWord(CONTROL_CMD_SEQUENCE)+1u;memory.words[CONTROL_CMD_SEQUENCE]=sequence==0u?1u:sequence;
}
// Nearest selectable item whose centre lies in the pressed direction, dominant axis, no wrap.
uint uiNeighbour(uint base,uint cursor,vec2 direction){
 uint items=uiWord(base+UI_HDR_ITEMS),best=cursor;float bestDistance=1e9;
 uvec4 from=uiRect(base,UI_ITEMS,cursor,1u);vec2 origin=vec2(from.xy)+vec2(from.zw)*0.5;
 for(uint i=0u;i<items;i++){
  if(i==cursor||(uiItemFlags(base,i)&UI_ITEM_GREYED)!=0u)continue;
  uvec4 r=uiRect(base,UI_ITEMS,i,1u);vec2 d=vec2(r.xy)+vec2(r.zw)*0.5-origin;
  float along=dot(d,direction),across=abs(dot(d,vec2(direction.y,direction.x)));
  if(along<=0.5||across>along)continue;
  float distance=along+across*2.0;
  if(distance<bestDistance){bestDistance=distance;best=i;}
 }
 return best;
}
// Input for the applied page: cursor moves on the console, presses become commands.
// Scratch: c.game.y chord frames, c.game.z stick repeat, c.game.w touch held.
void uiInput(){
 uint applied=uiWord(CONTROL_UI_APPLIED);
 if(uiWord(CONTROL_UI_MAGIC)!=UI_MAGIC||applied==0u)return;
 uint base=uiShownBase(),held=hbButtons(),pressed=hbPressed();
 bool sent=false;
 if(hbConnected()&&(held&(HB_L|HB_R))==(HB_L|HB_R)){
  c.game.y++;
  if(c.game.y==UI_CHORD_FRAMES){
   uiCommand(UI_OP_CHORD,0u,0u);sent=true;
   if((uiWord(base+UI_HDR_FLAGS)&UI_FLAG_OVERLAY)!=0u)memory.words[CONTROL_UI_OVERLAY]=1u;
  }
 }else c.game.y=0u;
 if((uiWord(base+UI_HDR_FLAGS)&UI_FLAG_OVERLAY)!=0u&&uiWord(CONTROL_UI_OVERLAY)==0u)return;
 uint items=uiWord(base+UI_HDR_ITEMS),cursor=min(uiWord(CONTROL_UI_CURSOR),max(items,1u)-1u);
 vec2 stick=hbStick(false);vec2 move=vec2(0);
 if((pressed&HB_UP)!=0u)move=vec2(0,-1);else if((pressed&HB_DOWN)!=0u)move=vec2(0,1);
 else if((pressed&HB_LEFT)!=0u)move=vec2(-1,0);else if((pressed&HB_RIGHT)!=0u)move=vec2(1,0);
 else if(length(stick)>0.6){
  if(c.game.z==0u){move=abs(stick.x)>abs(stick.y)?vec2(sign(stick.x),0):vec2(0,-sign(stick.y));c.game.z=UI_STICK_REPEAT;}
  else c.game.z--;
 }else c.game.z=0u;
 if(items>0u&&move!=vec2(0)){
  uint flags=uiItemFlags(base,cursor);
  if(move.y==0.0&&(flags&UI_ITEM_ADJUSTABLE)!=0u){if(!sent){uiCommand(UI_OP_ADJUST,uiItemId(base,cursor),move.x>0.0?1u:0xffffffffu);sent=true;}}
  else cursor=uiNeighbour(base,cursor,move);
 }
 bool touching=c.touch[2]==1u&&(c.touch[6]&2u)==0u;
 if(touching&&c.game.w==0u){
  vec2 p=vec2(c.touch[8],c.touch[9])*1.5;
  for(uint i=0u;i<items;i++)if((uiItemFlags(base,i)&UI_ITEM_GREYED)==0u&&uiInside(p,uiRect(base,UI_ITEMS,i,1u))){
   cursor=i;memory.words[CONTROL_UI_TOUCH_ITEM]=i;
   if(!sent){uiCommand(UI_OP_A,uiItemId(base,i),0u);sent=true;}
  }
 }
 c.game.w=touching?1u:0u;
 if(!sent&&items>0u){
  uint id=uiItemId(base,cursor);bool greyed=(uiItemFlags(base,cursor)&UI_ITEM_GREYED)!=0u;
  if((pressed&HB_A)!=0u&&!greyed){uiCommand(UI_OP_A,id,0u);sent=true;}
  else if((pressed&HB_X)!=0u){uiCommand(UI_OP_X,id,0u);sent=true;}
  else if((pressed&HB_Y)!=0u){uiCommand(UI_OP_Y,id,0u);sent=true;}
 }
 if(!sent&&(pressed&HB_B)!=0u){
  if((uiWord(base+UI_HDR_FLAGS)&UI_FLAG_OVERLAY)!=0u)memory.words[CONTROL_UI_OVERLAY]=0u;
  uiCommand(UI_OP_B,0u,0u);
 }
 memory.words[CONTROL_UI_CURSOR]=cursor;
}
#else
// Composes the shown page over `under` (the page background, or the dimmed video for an overlay).
vec3 uiDraw(vec2 p,vec3 under,float frames){
 uint base=uiShownBase(),flags=uiWord(base+UI_HDR_FLAGS);
 vec4 background=uiColor(uiWord(base+UI_HDR_BACKGROUND));
 vec3 color=mix(under,background.rgb,background.a);
 uint images=uiWord(base+UI_HDR_IMAGES),texts=uiWord(base+UI_HDR_TEXTS),items=uiWord(base+UI_HDR_ITEMS);
 for(uint i=0u;i<images;i++){
  uvec4 r=uiRect(base,UI_IMAGES,i,0u);
  if(!uiInside(p,r))continue;
  uvec2 q=uvec2(p)-r.xy;uint offset=uiWord(base+UI_IMAGES+i*8u+4u)+(q.y*r.z+q.x)*4u;
  vec4 texel=uiColor(uiWord(base+UI_BODY+offset/4u));
  color=mix(color,texel.rgb,texel.a);
 }
 for(uint i=0u;i<texts;i++){
  uvec4 r=uiRect(base,UI_TEXTS,i,0u);
  if(!uiInside(p,r))continue;
  uvec2 q=uvec2(p)-r.xy;uint offset=uiWord(base+UI_TEXTS+i*8u+4u)+q.y*r.z+q.x;
  vec4 ink=uiColor(uiWord(base+UI_TEXTS+i*8u+5u));
  color=mix(color,ink.rgb,ink.a*float(uiByte(base,(UI_BODY*4u)+offset))/255.0);
 }
 uint cursor=uiWord(CONTROL_UI_CURSOR);
 for(uint i=0u;i<items;i++){
  uvec4 r=uiRect(base,UI_ITEMS,i,1u);uint itemFlags=uiWord(base+UI_ITEMS+i*8u+5u);
  vec2 center=vec2(r.xy)+vec2(r.zw)*0.5,extent=vec2(r.zw)*0.5;
  if((itemFlags&UI_ITEM_CURRENT)!=0u)color=mix(color,vec3(.45,.95,.60),fill(length(p-vec2(float(r.x)-14.0,center.y))-4.0));
  if(i==cursor&&(flags&UI_FLAG_HIDE_CURSOR)==0u){
   float pulse=(itemFlags&UI_ITEM_PENDING)!=0u?.55+.45*sin(frames*.4):1.0;
   color=mix(color,vec3(.25,.85,.90),pulse*line(box(p,center,extent+4.0,8.0),2.0));
  }
 }
 if(uiWord(CONTROL_HOST_BUSY)!=0u){
  vec2 d=p-vec2(1860,60);float radius=length(d),angle=mod(atan(d.y,d.x)-frames*.15,6.28318530718);
  float ring=1.0-smoothstep(2.0,3.5,abs(radius-18.0));
  color=mix(color,vec3(.84,.91,.96),ring*smoothstep(0.0,.6,angle)*(1.0-smoothstep(3.6,4.4,angle)));
 }
 return color;
}
#endif
