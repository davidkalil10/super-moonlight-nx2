from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parent
fonts=['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf']
font=next(f for f in fonts if Path(f).exists())
atlas=Image.new('L',(1024,2048));draw=ImageDraw.Draw(atlas);header=[];y=2
for name,label,size in [('TITLE','Moonlight',96),('WAITING','Waiting for the PC stream',32),('RETURN','Hold + and - to return to HBLauncher',26)]:
 face=ImageFont.truetype(font,size);box=draw.textbbox((0,0),label,font=face);w,h=box[2]-box[0],box[3]-box[1]
 draw.text((2-box[0],y-box[1]),label,font=face,fill=255)
 header.append(f'const ivec4 TEXT_{name} = ivec4(2, {y}, {w}, {h});');y+=h+8
(root/'assets/text.bin').write_bytes(atlas.tobytes());(root/'backends/hblauncher.gpu-app/text.glsl').write_text('\n'.join(header)+'\n')
im=Image.new('RGBA',(256,256),(14,37,58,255));d=ImageDraw.Draw(im)
d.rounded_rectangle((26,42,230,214),radius=22,fill=(24,65,85),outline=(64,215,224),width=5)
d.polygon(((104,92),(104,164),(168,128)),fill=(111,246,221))
im.save(root/'assets/icon.png')
