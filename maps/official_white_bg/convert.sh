#!/bin/zsh
# Turn dark gray map backgrounds white; keep colored zones and white labels on them.
# Usage: convert.sh input output
P='st(0,max(max(r(X,Y),g(X,Y)),b(X,Y))-min(min(r(X,Y),g(X,Y)),b(X,Y)));st(1,clip((30-ld(0))/18,0,1));st(3,0.299*r(X,Y)+0.587*g(X,Y)+0.114*b(X,Y));st(2,min(255,(255-ld(3))*255/210));'
A="${P}st(4,ld(1));"
B="${P}st(4,ld(1)*clip((150-ld(3))/50,0,1));"
mix() { echo "r='$1ld(4)*ld(2)+(1-ld(4))*r(X,Y)':g='$1ld(4)*ld(2)+(1-ld(4))*g(X,Y)':b='$1ld(4)*ld(2)+(1-ld(4))*b(X,Y)'"; }
M="${P}clip((ld(0)-25)*20,0,255)"
ffmpeg -loglevel error -y -i "$1" -filter_complex "
[0]format=gbrp,split=3[a][b][c];
[a]geq=$(mix "$A")[A];
[b]geq=$(mix "$B")[B];
[c]geq=r='$M':g='$M':b='$M',boxblur=24:2,geq=r='clip(r(X,Y)*8,0,255)':g='clip(g(X,Y)*8,0,255)':b='clip(b(X,Y)*8,0,255)'[M];
[A][B][M]maskedmerge,format=rgb24" -q:v 2 "$2"
