// ── SAFE STORAGE ─────────────────────────────────────────────────────────────
// Browser storage can exist and still be unusable. Privacy modes, blocked site
// data, embedded webviews and automated browsers variously leave
// window.localStorage undefined or null, make merely reading the property
// throw, or keep the object but throw SecurityError from every method. Any of
// those used to reject bootPortal() before the login screen was shown.
//
// These helpers never throw. A read that cannot happen returns null (the same
// value a missing key returns), and a write or removal that cannot happen
// returns false. Storage is resolved on every call rather than captured once,
// so the 01-core.js sync interceptor (which patches localStorage.setItem)
// still sees writes made through safeStorageSet.
//
// Scope: the startup, authentication and logout paths. Feature code keeps its
// own local try/catch handling.
(function(global){
  function resolveStorage(){
    try{
      var store=global.localStorage;
      return store&&typeof store.getItem==='function'?store:null;
    }catch(e){return null;}
  }
  function safeStorageGet(key){
    var store=resolveStorage();
    if(!store)return null;
    try{
      var value=store.getItem(key);
      return value==null?null:String(value);
    }catch(e){return null;}
  }
  function safeStorageSet(key,value){
    var store=resolveStorage();
    if(!store)return false;
    try{store.setItem(key,value);return true;}catch(e){return false;}
  }
  function safeStorageRemove(key){
    var store=resolveStorage();
    if(!store)return false;
    try{store.removeItem(key);return true;}catch(e){return false;}
  }
  global.safeStorageGet=safeStorageGet;
  global.safeStorageSet=safeStorageSet;
  global.safeStorageRemove=safeStorageRemove;
})(typeof window!=='undefined'?window:globalThis);
