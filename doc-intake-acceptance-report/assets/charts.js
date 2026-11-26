/* doc-intake 验收报告图表（颜色全部取自 CSS 变量） */
(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  /* ---- 图 1 · Mermaid 分治流水线 ---- */
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
  }

  /* ---- 图 2 · Token 降本对比（对数轴） ---- */
  var elToken = document.getElementById('chart-token');
  if (elToken && window.echarts) {
    var chartToken = echarts.init(elToken, null, { renderer: 'svg' });
    chartToken.setOption({
      animation: false,
      tooltip: { trigger: 'axis', appendToBody: true, axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { color: muted, fontFamily: 'Work Sans, Microsoft YaHei, sans-serif' } },
      grid: { top: 44, left: 8, right: 24, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: ['内置样本（8,500 行大表）', '上传 CSV（8,500 行回传）'],
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: ink, fontFamily: 'Work Sans, Microsoft YaHei, sans-serif', fontSize: 13 },
      },
      yAxis: {
        type: 'log',
        name: 'tokens（对数轴）',
        nameTextStyle: { color: muted },
        logBase: 10,
        axisLine: { show: false },
        splitLine: { lineStyle: { color: rule } },
        axisLabel: { color: muted, formatter: function (v) { return echarts.format.addCommas(v); } },
      },
      series: [
        {
          name: '传统直塞（全表 + 全文）',
          type: 'bar',
          barWidth: 56,
          data: [392913, 392464],
          itemStyle: { color: accent2, borderRadius: [3, 3, 0, 0] },
          label: { show: true, position: 'top', color: accent2, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, formatter: function (p) { return echarts.format.addCommas(p.value); } },
        },
        {
          name: '分治架构（摘要 + Top5 异常）',
          type: 'bar',
          barWidth: 56,
          data: [1920, 1309],
          itemStyle: { color: accent, borderRadius: [3, 3, 0, 0] },
          label: { show: true, position: 'top', color: accent, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, formatter: function (p) { return echarts.format.addCommas(p.value) + '（省 ' + (p.value === 1920 ? '99.5' : '99.7') + '%）'; } },
        },
      ],
    });
    window.addEventListener('resize', function () { chartToken.resize(); });
  }

  /* ---- 图 3 · SSE 事件分布（对数轴） ---- */
  var elSse = document.getElementById('chart-sse');
  if (elSse && window.echarts) {
    var chartSse = echarts.init(elSse, null, { renderer: 'svg' });
    var cats = ['text_delta', 'step', 'phase', 'notice', 'card', 'usage', 'done'];
    var vals = [541, 23, 4, 4, 3, 1, 1];
    chartSse.setOption({
      animation: false,
      tooltip: { trigger: 'axis', appendToBody: true, axisPointer: { type: 'shadow' } },
      grid: { top: 12, left: 8, right: 56, bottom: 8, containLabel: true },
      xAxis: {
        type: 'log',
        logBase: 10,
        name: '次数（对数轴）',
        nameTextStyle: { color: muted },
        splitLine: { lineStyle: { color: rule } },
        axisLabel: { color: muted },
      },
      yAxis: {
        type: 'category',
        data: cats.slice().reverse(),
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false },
        axisLabel: { color: ink, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 },
      },
      series: [
        {
          name: '事件次数',
          type: 'bar',
          barWidth: 20,
          data: vals.slice().reverse().map(function (v, i) {
            return {
              value: v,
              itemStyle: { color: i === vals.length - 1 ? accent2 : accent, borderRadius: [0, 3, 3, 0] },
            };
          }),
          label: { show: true, position: 'right', color: ink, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 },
        },
      ],
    });
    window.addEventListener('resize', function () { chartSse.resize(); });
  }
})();
