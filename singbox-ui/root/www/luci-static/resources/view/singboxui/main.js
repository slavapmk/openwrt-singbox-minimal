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
function execute(action) {
 return fs.exec(helper, [action]).then(function(r) {
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'Ошибка команды');
  return r.stdout || '';
 });
}
function notify(error, text) {
 ui.addNotification(null, E('p', {}, text), error ? 'danger' : 'info');
}
function actionButton(label, action) {
 return E('button', {'class':'cbi-button cbi-button-action', 'click':ui.createHandlerFn(null, function() {
  return execute(action).then(function(s) {notify(false,s);}).catch(function(e) {notify(true,e.message);});
 })}, label);
}
return view.extend({
 load: function() {
  return Promise.all([uci.load('singboxui'), fs.read('/etc/singbox-ui/config.json')]);
 },
 render: function(data) {
  var self=this;
  var m=new form.Map('singboxui','Sing-box',
   'Минимальная сборка HY2/SNI. Бинарник и списки — в RAM; настройки и JSON — в постоянной памяти.');
  this.map=m;
  var status=E('div', {'class':'cbi-section'}, 'Проверка состояния…');
  var logs=E('textarea', {'readonly':'', 'rows':12, 'style':'width:100%;font-family:monospace'}, '');
  function update() {
   return execute('status').then(function(text) {
    var s=JSON.parse(text);
    var states={running:'работает',stopped:'остановлен',downloading:'скачивается бинарник',waiting:'ожидание повторной загрузки',preparing:'подготовка запуска',loading_rules:'загрузка списков',checking:'проверка конфигурации',error:'ошибка запуска'};
    status.textContent=(s.running ? 'Работает' : (states[s.state] || s.state)) +
     ' · RAM: '+(Number(s.ram)/1024).toFixed(1)+' МиБ · '+(s.version || 'бинарник не загружен') + (s.error ? ' · '+s.error : '');
    logs.value=s.log || 'Журнал пока пуст';
   }).catch(function(e) {status.textContent='Ошибка состояния: '+e.message;});
  }
  var s=m.section(form.NamedSection,'main','main');
  s.tab('core','Бинарник');
  s.tab('json','Конфигурация JSON');
  s.tab('start','Запуск');
  s.tab('routing','Перехват LAN');
  var o=s.taboption('core',form.DynamicList,'source','Источники по порядку',
   'Прямые HTTP/HTTPS-ссылки на распакованный ELF-файл MIPSLE. Сначала NAS, затем GitHub raw или release asset. ZIP/GZIP не поддерживаются.');
  o.validate=function(section,value) {
   return !value || /^https?:\/\/[^\s]+$/i.test(value) ? true : 'Нужна HTTP/HTTPS-ссылка без пробелов';
  };
  o=s.taboption('core',form.Value,'sha256','SHA-256 бинарника');
  o.rmempty=false;
  o.validate=function(section,value) {return /^[a-f0-9]{64}$/i.test(value || '') ? true : '64 шестнадцатеричных символа';};
  o=s.taboption('core',form.DummyValue,'binaryinfo','Загрузка');
  o.rawhtml=false;
  o.cfgvalue=function() {return 'После перезагрузки файл скачивается заново. При обычном перезапуске проверенная копия в /tmp используется повторно. При ошибке источника пробуем следующий; при ошибке SHA-256 файл отклоняется.';};

  o=s.taboption('json',form.TextValue,'editor','Рабочая конфигурация',
   'Это единственный источник настроек серверов и маршрутов. Интерфейс не генерирует и не переписывает содержимое JSON.');
  o.rows=28; o.monospace=true; o.rmempty=false; o.forcewrite=true;
  o.load=function() {return data[1];};
  o.cfgvalue=function() {return data[1];};
  o.validate=function(section,value) {
   try {var c=JSON.parse(value); return c && !Array.isArray(c) && typeof c==='object' ? true : 'Ожидается JSON-объект';}
   catch(e) {return e.message;}
  };
  o.write=function(section,value) {return fs.write('/etc/singbox-ui/config.pending.json',value+'\n',384);};
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
   var save=E('button',{'class':'cbi-button','click':function(ev) {
    ev.preventDefault();
    var url=URL.createObjectURL(new Blob([value()],{type:'application/json'}));
    var a=E('a',{'href':url,'download':'sing-box-config.json'});a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
   }},'Скачать JSON');
   var check=E('button',{'class':'cbi-button','click':ui.createHandlerFn(null,function() {
    try {JSON.parse(value());}catch(e){notify(true,e.message);return;}
    return fs.write('/etc/singbox-ui/config.pending.json',value()+'\n',384)
     .then(function(){return execute('check');}).then(function(){notify(false,'Проверка sing-box пройдена');}).catch(function(e){notify(true,e.message);});
   })},'Проверить JSON');
   return E('div',{},[input,save,check,actionButton('Предыдущий рабочий JSON','rollback')]);
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

  s=m.section(form.GridSection,'ruleset','Файлы правил',
   'Небольшие SRS/JSON-файлы из HTTP/HTTPS. Загружаются перед запуском; кнопка ниже обновляет их вручную. В JSON указывайте local rule-set с path /tmp/singbox-ui/rules/ИМЯ. Лимит одного файла — 2 МиБ; суммарный расход RAM зависит от списков.');
  s.anonymous=true;s.addremove=true;
  o=s.option(form.Flag,'enabled','Включён');o.default='1';o.rmempty=false;
  o=s.option(form.Value,'filename','Имя файла');o.placeholder='geosite-small.srs';o.rmempty=false;
  o.validate=function(section,v){return /^[a-z0-9_-]+\.(srs|json)$/i.test(v || '') ? true : 'Имя вида name.srs или name.json';};
  o=s.option(form.Value,'url','URL');o.rmempty=false;
  o.validate=function(section,v){return /^https?:\/\/[^\s]+$/i.test(v || '') ? true : 'Нужна HTTP/HTTPS-ссылка';};
  o=s.option(form.Value,'sha256','SHA-256 списка (необязательно)');
  o.validate=function(section,v){return !v || /^[a-f0-9]{64}$/i.test(v) ? true : '64 шестнадцатеричных символа';};

  return m.render().then(function(node) {
   poll.add(update,10);update();
   return E('div',{},[status,E('div',{'class':'cbi-section'},[
    actionButton('Запустить','start'),actionButton('Остановить','stop'),actionButton('Перезапустить','restart')]),
    node,E('div',{'class':'cbi-section'},[actionButton('Загрузить сохранённые списки','assets')]),
    E('h3',{},'Журнал'),logs]);
  });
 },
 handleSave:null,
 handleSaveApply:function() {
  return this.map.save().then(function(){return commit('singboxui');})
   .then(function(){return execute('apply');})
   .then(function(text){notify(false,text);window.location.reload();})
   .catch(function(e){notify(true,e.message);});
 },
 handleReset:function(){return this.map.reset();}
});
