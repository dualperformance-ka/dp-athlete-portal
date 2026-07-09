var manualLoginIntent=false;
// Codes are uppercase first names, de-duped with a numeric suffix (THOMAS2),
// so they can exceed 6 chars — allow up to 10 and grow the boxes to fit.
function sanitizeCode(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10);}
function syncCodeBoxCount(len){
  var wrap=document.getElementById('codeBoxes');if(!wrap)return;
  var want=Math.max(6,len);
  while(wrap.children.length<want){var b=document.createElement('div');b.className='code-box';wrap.appendChild(b);}
  while(wrap.children.length>want){wrap.removeChild(wrap.lastChild);}
}
function renderCode(){
  var inp=document.getElementById('codeInput');if(!inp)return;
  var v=sanitizeCode(inp.value||'');if(inp.value!==v) inp.value=v;
  syncCodeBoxCount(v.length);
  var boxes=document.querySelectorAll('#codeBoxes .code-box');
  var active=v.length<boxes.length?v.length:-1;
  for(var i=0;i<boxes.length;i++){
    boxes[i].textContent=v.charAt(i)||'';
    boxes[i].classList.toggle('active',i===active);
    boxes[i].classList.toggle('filled',!!v.charAt(i));
  }
  var btn=document.getElementById('loginBtn');
  if(btn){btn.disabled=v.length<1;btn.classList.toggle('ready',v.length>0);}
  if(v.length>0) clearLoginError();
}
function handleCodePaste(event){
  event.preventDefault();
  var text=(event.clipboardData||window.clipboardData).getData('text');
  var inp=document.getElementById('codeInput');if(!inp)return;
  inp.value=sanitizeCode(text);renderCode();
  if(inp.value.length>=2) setTimeout(login,80);
}
function handleCodeKey(event){
  if(event.key==='Enter') login();
  if(event.key==='Backspace') clearLoginError();
}
function clearLoginError(){
  var card=document.getElementById('loginCard');if(card) card.classList.remove('login-error-shake');
  var err=document.getElementById('lerr');if(err) err.style.display='none';
}
function showLoginError(msg){
  var err=document.getElementById('lerr');if(err){err.textContent=msg||'Invalid code — check with your coach';err.style.display='block';}
  var card=document.getElementById('loginCard');if(card){card.classList.remove('login-error-shake');void card.offsetWidth;card.classList.add('login-error-shake');}
  var inp=document.getElementById('codeInput');if(inp) inp.focus();
}
function setLoginKeyboardState(active){
  var screen=document.getElementById('loginScreen');if(!screen)return;
  screen.classList.toggle('keyboard-open',!!active);
}
function syncLoginViewport(){
  var screen=document.getElementById('loginScreen');if(!screen||!window.visualViewport)return;
  var keyboardOpen=window.visualViewport.height < window.innerHeight*0.78;
  screen.classList.toggle('keyboard-open',keyboardOpen||document.activeElement===document.getElementById('codeInput'));
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',syncLoginViewport);
  window.visualViewport.addEventListener('scroll',syncLoginViewport);
}
function showLoginSuccess(name){
  var screen=document.getElementById('loginScreen');
  var nameEl=document.getElementById('loginSuccessName');
  if(nameEl) nameEl.textContent='Welcome, '+(name||'Athlete');
  if(screen){screen.classList.remove('keyboard-open');screen.classList.add('login-authed');}
}
function hideLoginSuccess(){
  var screen=document.getElementById('loginScreen');
  if(screen) screen.classList.remove('login-authed');
}
renderCode();
