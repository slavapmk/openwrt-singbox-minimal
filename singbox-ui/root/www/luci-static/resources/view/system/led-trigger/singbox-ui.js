'use strict';
'require baseclass';
'require form';
return baseclass.extend({
 trigger: 'Sing-box: состояние службы',
 kernel: false,
 description: 'Индикатор горит при выбранном состоянии. «Работает» означает запущенный процесс, а не проверенную доступность VPN.',
 addFormOptions: function(s) {
  var o=s.option(form.ListValue,'singbox_state','Состояние Sing-box');
  o.depends('trigger','singbox-ui');
  o.value('initializing','Инициализация / загрузка');
  o.value('running','Работает');
  o.value('error','Ошибка');
  o.default='initializing';
 }
});
