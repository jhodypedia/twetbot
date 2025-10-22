/* global $, EventSource */
$(function(){
  const $toast = $('.toast');
  const sound = document.getElementById('notifySound');
  function toast(msg,type='info'){
    const cls = {ok:'success',err:'danger',info:'info'}[type] || 'info';
    const $i = $(`<div class="item ${cls}">${msg}</div>`).appendTo($toast);
    sound.currentTime=0; sound.play().catch(()=>{});
    setTimeout(()=> $i.fadeOut(300,()=> $i.remove()),4000);
  }

  // SSE realtime logs
  if (window.location.pathname.startsWith('/admin')){
    try{
      const es = new EventSource('/admin/logs/stream');
      es.onmessage = e=>{
        $('#logs').prepend(`[${new Date().toLocaleTimeString()}] ${e.data}\n`);
        if(/✅/.test(e.data)) toast(e.data,'ok');
        if(/❌/.test(e.data)) toast(e.data,'err');
      };
    }catch(e){ console.error(e); }
  }

  // AJAX Broadcast
  $('#formBroadcast').on('submit',function(ev){
    ev.preventDefault();
    const $b=$(this).find('button'); $b.prop('disabled',true).text('Starting...');
    $.post('/admin/broadcast',$(this).serialize())
      .done(()=>toast('Broadcast started','ok'))
      .fail(x=>toast(x.responseText||'Error','err'))
      .always(()=> $b.prop('disabled',false).text('Start Broadcast'));
  });

  // AJAX Settings
  $('#formSettings').on('submit',function(ev){
    ev.preventDefault();
    const $b=$(this).find('button'); $b.prop('disabled',true).text('Saving...');
    $.post('/admin/settings',$(this).serialize())
      .done(()=>toast('Settings saved','ok'))
      .fail(x=>toast(x.responseText||'Error','err'))
      .always(()=> $b.prop('disabled',false).text('Save'));
  });

  // Sidebar toggle
  $('#menuBtn').on('click',()=> $('body').toggleClass('menu-open'));
  // Dark mode toggle
  $('#themeToggle').on('click',()=>{
    $('html').toggleClass('dark');
    const icon=$('#themeToggle i');
    icon.toggleClass('fa-sun-o fa-moon-o');
  });

  // Skeleton loader animation (demo)
  $('.skeleton-parent').each(function(){
    const $t=$(this);
    const s=$('<div class="skeleton"></div>').appendTo($t);
    setTimeout(()=>s.remove(),800);
  });
});
