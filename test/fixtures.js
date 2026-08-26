// 一行真实结构（取自 page_content.html 第一行），作为 fixture 的独立真相源。
// id = 20250930_542694266；第二行是另一条新记录，用于断言多行场景。
const ROW_KNOWN = `<tr><td><a class="firstTdAAA" href="/inviteBid/detail/20250930_542694266.html">孝感市特殊教育学校2025年09政府采购意向</a></td><td>招标预告</td><td>湖北孝感</td><td>2025/09/30</td></tr>`;
const ROW_NEW = `<tr><td><a class="firstTdAAA" href="/inviteBid/detail/20250930_999999999.html">某新单位采购意向</a></td><td>招标预告</td><td>湖北武汉</td><td>2025/09/30</td></tr>`;

function pageHtml(rows) {
  return `<table id="treeTable"><tbody>${rows.join('')}</tbody></table>`;
}

// 参数化数据行（同 ROW_NEW 形状，id 可注入）：多页 mock 各页唯一 id，避免误触无新数据早停
function yfbzbRow(id) {
  return `<tr><td><a class="firstTdAAA" href="/inviteBid/detail/${id}.html">测试单位采购意向</a></td><td>招标预告</td><td>湖北武汉</td><td>2025/09/30</td></tr>`;
}

// yfbzb 分页控件（结构仿真史快照 page_content.html）：
// 数字页码链接 + li.controls 文本「当前 <input> / <input> 条，共 N 条」
function yfbzbPagination({ totalRecords, pageSize = 30, lastPage }) {
  const pages = lastPage || Math.ceil(totalRecords / pageSize);
  const links = [];
  for (let p = 1; p <= pages; p++) {
    links.push(`<li${p === 1 ? ' class="active"' : ''}><a href="javascript:" onclick="page(${p},${pageSize},'');return false;">${p}</a></li>`);
  }
  return `<div class="pagination"><ul>`
    + `<li class="disabled"><a href="javascript:">上一页</a></li>`
    + links.join('')
    + `<li class="disabled"><a href="javascript:">...</a></li>`
    + `<li><a href="javascript:">下一页</a></li>`
    + `<li class="disabled controls"><a href="javascript:">当前 <input type="text" value="1"/> / <input type="text" value="${pageSize}"/> 条，共 ${totalRecords} 条</a></li>`
    + `</ul></div>`;
}

// ceb 分页控件（结构仿真史快照 page_content_ceb.html）：
// 「共N页 当前页是第1页」+ 隐藏域 #pageTotal（历史快照值带尾随空格且与共N页矛盾）
function cebPagination(pages, pageTotalValue) {
  const hidden = pageTotalValue === undefined ? '' : `<input type="hidden" id ="pageTotal" name="pageTotal" value="${pageTotalValue} "/>`;
  return `<div class="pagination">共<label>${pages}</label>页 `
    + `<a href="javascript:void(0);" onClick="turnPage(2);">下一页</a>`
    + `<a href="javascript:void(0);" onClick="turnPage(${pages});">末页</a>`
    + `当前页是第<label>1</label>页`
    + `<input type="hidden" id ="pageIndex" name="pageIndex" value="1"/>`
    + `${hidden}</div>`;
}

module.exports = {
  ROW_KNOWN,
  ROW_NEW,
  KNOWN_ID: '20250930_542694266',
  NEW_ID: '20250930_999999999',
  pageHtml,
  yfbzbRow,
  yfbzbPagination,
  cebPagination
};
