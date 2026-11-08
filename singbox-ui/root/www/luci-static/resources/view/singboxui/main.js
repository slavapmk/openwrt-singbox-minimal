'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require fs';
'require ui';
'require poll';

var commit = rpc.declare({object:'uci', method:'commit', params:['config']});
var helper = '/usr/libexec/singbox-ui';
function execute(action, args) {
 return fs.exec(helper, [action].concat(args || [])).then(function(r) {
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'Ошибка команды');
  return r.stdout || '';
 });
}
function notify(error, text) {
 ui.addNotification(null, E('p', {}, text), error ? 'danger' : 'info');
}
function actionButton(label, action, args, after) {
 return E('button', {'type':'button', 'class':'cbi-button cbi-button-action', 'click':ui.createHandlerFn(null, function() {
  return execute(action,args).then(function(s) {notify(false,s);return after ? after() : null;}).catch(function(e) {notify(true,e.message);});
 })}, label);
}
return view.extend({
 load: function() {
  return Promise.all([uci.load('singboxui'), fs.read('/etc/singbox-ui/config.json'),
   fs.read('/etc/singbox-ui/config.pending.json').catch(function(){return null;})]);
 },
 render: function(data) {
  var self=this;
  var editorText=data[2] != null ? data[2] : data[1];
  var m=new form.Map('singboxui','Sing-box',
   'Минимальная сборка HY2/SNI. Бинарник и списки — в RAM; настройки и JSON — в постоянной памяти.');
  this.map=m;
  var status=E('div', {'class':'cbi-section'}, 'Проверка состояния…');
  var logs=E('textarea', {'readonly':'', 'rows':12, 'style':'width:100%;font-family:monospace'}, '');
  var logGeneration=0;
  var binStatus=E('p',{},'Проверка Bin…');
  var fileStatus=E('p',{},'');
  var inventory=E('pre',{},'Geo-файлов в RAM пока нет');
  var fileRows={};
  function bytes(value) {return (Number(value || 0)/1048576).toFixed(2)+' МиБ';}
  function reloadEditor() {
   return fs.read('/etc/singbox-ui/config.json').then(function(text) {
    data[1]=text;
    var editor=self.editor.getUIElement('main');
    if(editor) {editor.setValue(text);editor.triggerValidation();}
   });
  }
  function update() {
   var generation=logGeneration;
   return execute('status').then(function(text) {
    var s=JSON.parse(text);
    var states={running:'работает',stopped:'остановлен',downloading:'скачивается бинарник',waiting:'ожидание повторной загрузки',preparing:'подготовка запуска',loading_rules:'загрузка списков',checking:'проверка конфигурации',error:'ошибка запуска'};
    status.textContent=(s.running ? 'Работает' : (states[s.state] || s.state)) +
     ' · RAM: '+(Number(s.ram)/1024).toFixed(1)+' МиБ · '+(s.version || 'бинарник не загружен') + (s.error ? ' · '+s.error : '');
    if(generation===logGeneration) logs.value=s.log || '';
    binStatus.textContent=s.binary_present ? '/tmp/sing-box · '+bytes(s.binary_size)+' · '+(s.version || 'не исполняется') : 'Bin отсутствует в RAM';
    var operations={startup:'подготовка файлов для запуска','download-bin':'скачивание Bin','remove-bin':'удаление Bin',assets:'скачивание Geo Files','remove-assets':'удаление Geo Files','download-asset':'скачивание Geo-файла','remove-asset':'удаление Geo-файла',done:'завершено',failed:'ошибка'};
    fileStatus.textContent='Файлы: '+(operations[s.files_state] || s.files_state || 'операций пока нет')+(s.files_busy ? ' · выполняется' : '')+(s.files_error ? ' · '+s.files_error : '');
    var files=s.files || [];
    inventory.textContent=files.length ? files.map(function(f){return f.name+' · '+bytes(f.size);}).join('\n') : 'Geo-файлов в RAM пока нет';
    Object.keys(fileRows).forEach(function(section) {
     var name=uci.get('singboxui',section,'filename');
     var file=files.filter(function(f){return f.name===name;})[0];
     fileRows[section].textContent=file ? bytes(file.size)+' в RAM' : 'Нет в RAM';
    });
   }).catch(function(e) {status.textContent='Ошибка состояния: '+e.message;});
  }
  var s=m.section(form.NamedSection,'main','main');
  s.tab('core','Bin');
  s.tab('geo','Geo Files');
  s.tab('json','Конфигурация JSON');
  s.tab('start','Настройки запуска');
  s.tab('routing','Перехват LAN');
  s.tab('logs','Логи');
  var o=s.taboption('core',form.DynamicList,'source','Источники по порядку',
   'Прямые HTTP/HTTPS-ссылки на распакованный ELF-файл MIPSLE. Сначала NAS, затем GitHub raw или release asset. ZIP/GZIP не поддерживаются.');
  o.validate=function(section,value) {
   return !value || /^https?:\/\/[^\s]+$/i.test(value) ? true : 'Нужна HTTP/HTTPS-ссылка без пробелов';
  };
  o=s.taboption('core',form.Value,'sha256','SHA-256 бинарника');
  o.rmempty=false;
  o.validate=function(section,value) {return /^[a-f0-9]{64}$/i.test(value || '') ? true : '64 шестнадцатеричных символа';};
  o=s.taboption('core',form.DummyValue,'binary_files','Bin в RAM');
  o.renderWidget=function() {return E('div',{},[binStatus,
   actionButton('Удалить Bin из RAM','remove-bin',[],update),
   E('p',{},'«Скачать Bin» загружает файл по сохранённым URL и проверяет SHA-256. Для замены или удаления сначала остановите службу. «Запустить» автоматически проверяет Bin и загружает недостающие Geo-файлы.')]);};
  o=s.taboption('core',form.DummyValue,'binaryinfo','Загрузка');
  o.rawhtml=false;
  o.cfgvalue=function() {return 'После перезагрузки файл скачивается заново. При обычном перезапуске проверенная копия в /tmp используется повторно. При ошибке источника пробуем следующий; при ошибке SHA-256 файл отклоняется.';};

  o=s.taboption('json',form.TextValue,'editor','Конфигурация JSON',
   '«Сохранить» сохраняет JSON для следующего запуска. «Сохранить и применить» проверяет и применяет его. Автоматического отката нет: ошибка остаётся видимой.');
  o.rows=28; o.monospace=true; o.rmempty=false; o.forcewrite=true;
  o.load=function() {return editorText;};
  o.cfgvalue=function() {return editorText;};
  o.validate=function(section,value) {
   try {var c=JSON.parse(value); return c && !Array.isArray(c) && typeof c==='object' ? true : 'Ожидается JSON-объект';}
   catch(e) {return e.message;}
  };
  o.write=function(section,value) {
   if (value.trim() === data[1].trim())
    return fs.write('/etc/singbox-ui/config.pending.json',data[1],384);
   return fs.write('/etc/singbox-ui/config.pending.json',value+'\n',384);
  };
  this.editor=o;
  var tools=s.taboption('json',form.DummyValue,'json_tools','Файлы и проверка');
  tools.renderWidget=function(section) {
   function editorNode() {return self.editor.getUIElement(section);}
   function value() {var n=editorNode();return n ? n.getValue() : data[1];}
   var input=E('input', {'type':'file','accept':'.json,application/json','change':function(ev) {
    var file=ev.target.files[0]; if (!file) return;
    if (file.size>262144) {notify(true,'Лимит JSON: 256 КиБ');return;}
    file.text().then(function(text) {JSON.parse(text); var n=editorNode();if(n){n.setValue(text);n.triggerValidation();}}).catch(function(e){notify(true,e.message);});
   }});
   var save=E('button',{'type':'button','class':'cbi-button','click':function(ev) {
    ev.preventDefault();
    var url=URL.createObjectURL(new Blob([value()],{type:'application/json'}));
    var a=E('a',{'href':url,'download':'sing-box-config.json'});a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
   }},'Скачать JSON');
   var check=E('button',{'type':'button','class':'cbi-button','click':ui.createHandlerFn(null,function() {
    try {JSON.parse(value());}catch(e){notify(true,e.message);return;}
    return fs.write('/etc/singbox-ui/config.check.json',value()+'\n',384)
     .then(function(){return execute('check');}).then(function(){notify(false,'Проверка sing-box пройдена');}).catch(function(e){notify(true,e.message);});
   })},'Проверить JSON');
   return E('div',{},[input,save,check,actionButton('Восстановить предыдущий JSON','rollback',[],function(){return reloadEditor().then(update);}),E('button',{'type':'button','class':'cbi-button','click':ui.createHandlerFn(null,function(){return reloadEditor().catch(function(e){notify(true,e.message);});})},'Прочитать JSON с роутера')]);
  };

  o=s.taboption('start',form.Flag,'autostart','Автозапуск');o.rmempty=false;
  o=s.taboption('start',form.Value,'delay','Задержка запуска, секунд');o.datatype='range(0,3600)';o.rmempty=false;
  o=s.taboption('start',form.Value,'retry','Повтор загрузки, секунд');o.datatype='range(5,3600)';o.rmempty=false;
  o=s.taboption('start',form.Value,'gogc','GOGC','Частота сборки мусора Go. Меньше — экономнее RAM, больше нагрузка CPU. Начните со 100.');o.datatype='range(10,1000)';o.rmempty=false;
  o=s.taboption('start',form.Value,'gomemlimit','GOMEMLIMIT','Мягкий ориентир памяти Go, не жёсткий предел RAM процесса. По умолчанию пусто; пример: 32MiB.');
  o.validate=function(section,v){return !v || /^[0-9]{1,4}MiB$/.test(v) ? true : 'Например 32MiB либо пусто';};

  o=s.taboption('routing',form.Flag,'transparent','Перехватывать трафик LAN');o.rmempty=false;
  o=s.taboption('routing',form.Value,'interface','Интерфейс LAN');o.default='br-lan';o.rmempty=false;
  o.validate=function(section,v){return /^[a-z0-9_.:-]{1,15}$/i.test(v || '') ? true : 'Некорректное имя интерфейса';};
  o=s.taboption('routing',form.Value,'port','Порт TPROXY','Должен совпадать с входом tproxy в JSON. DNS 53/853 остаётся вне перехвата.');o.datatype='port';o.rmempty=false;
  o=s.taboption('routing',form.DummyValue,'routing_note','Поведение');
  o.cfgvalue=function(){return 'Перехватываются TCP/UDP устройств LAN. Действие VPN/напрямую/блокировка определяется JSON. До первого запуска ядра перехват не включён. Остановка службы отключает перехват; при аварии процесса правила остаются до его перезапуска. ECH может скрывать имя.';};

  o=s.taboption('geo',form.DummyValue,'geo_actions','Управление файлами');
  o.renderWidget=function(){return E('div',{},[
   actionButton('Скачать Geo Files','assets',[],update),
   actionButton('Удалить Geo Files из RAM','remove-assets',[],update),inventory]);};
  var geoSection=s.taboption('geo',form.SectionValue,'geo_files',form.GridSection,'ruleset','Geo Files',
   'Небольшие SRS/JSON-файлы из HTTP/HTTPS. Загружаются перед запуском; можно скачать и удалить вручную без запуска ядра. Операции используют сохранённые настройки. В JSON указывайте local rule-set с path /tmp/singbox-ui/rules/ИМЯ. Лимит одного файла — 2 МиБ; суммарный расход RAM зависит от списков.');
  var g=geoSection.subsection;
  g.anonymous=true;g.addremove=true;
  o=g.option(form.Flag,'enabled','Включён');o.default='1';o.rmempty=false;
  o=g.option(form.Value,'filename','Имя файла');o.placeholder='geosite-small.srs';o.rmempty=false;
  o.validate=function(section,v){return /^[a-z0-9_-]+\.(srs|json)$/i.test(v || '') ? true : 'Имя вида name.srs или name.json';};
  o=g.option(form.Value,'url','URL');o.rmempty=false;
  o.validate=function(section,v){return /^https?:\/\/[^\s]+$/i.test(v || '') ? true : 'Нужна HTTP/HTTPS-ссылка';};
  o=g.option(form.Value,'sha256','SHA-256 списка (необязательно)');
  o.validate=function(section,v){return !v || /^[a-f0-9]{64}$/i.test(v) ? true : '64 шестнадцатеричных символа';};

  o=g.option(form.DummyValue,'file_actions','Файл в RAM');
  o.renderWidget=function(section) {
   var info=E('span',{},'Проверка…');fileRows[section]=info;
   return E('div',{},[info,E('br'),
    actionButton('Скачать','download-asset',[section],update),
    actionButton('Удалить из RAM','remove-asset',[section],update)]);
  };
  o=s.taboption('logs',form.DummyValue,'app_logs','Журнал приложения');
  o.renderWidget=function(){return E('div',{},[
   E('p',{},'Журнал хранится в RAM: до двух файлов по 64 КиБ. Ниже — весь сохранённый журнал и вывод последней операции с файлами. Очистка удаляет записи журнала приложения; новые сообщения продолжают поступать.'),
   E('button',{'type':'button','class':'cbi-button','click':ui.createHandlerFn(null,function() {
    logGeneration++;
    return execute('clear-log').then(function(text){logGeneration++;logs.value='';notify(false,text);return update();})
     .catch(function(e){notify(true,e.message);});
   })},'Очистить журнал'),
   E('button',{'type':'button','class':'cbi-button','click':ui.createHandlerFn(null,update)},'Обновить'),logs]);};

  return m.render().then(function(node) {
   poll.add(update,10);update();
   return E('div',{},[status,E('div',{'class':'cbi-section'},[
    actionButton('Скачать Bin','download-bin',[],update),
    actionButton('Запустить','start',[],update),actionButton('Остановить','stop',[],update),actionButton('Перезапустить','restart',[],update)]),fileStatus,node]);
  });
 },
 handleSave:function() {
  return this.map.save().then(function(){return commit('singboxui');})
   .then(function(){notify(false,'Настройки сохранены без запуска службы. JSON сохранён для следующего запуска.');})
   .catch(function(e){notify(true,e.message);});
 },
 handleSaveApply:function() {
  return this.map.save().then(function(){return commit('singboxui');})
   .then(function(){return execute('apply');})
   .then(function(text){notify(false,text);window.location.reload();})
   .catch(function(e){notify(true,e.message);});
 },
 handleReset:function(){notify(false,'Несохранённые изменения формы сброшены. Для журнала используйте «Очистить журнал» во вкладке «Логи».');return this.map.reset();}
});
