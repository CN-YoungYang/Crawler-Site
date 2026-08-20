// 一行真实结构（取自 page_content.html 第一行），作为 fixture 的独立真相源。
// id = 20250930_542694266；第二行是另一条新记录，用于断言多行场景。
const ROW_KNOWN = `<tr><td><a class="firstTdAAA" href="/inviteBid/detail/20250930_542694266.html">孝感市特殊教育学校2025年09政府采购意向</a></td><td>招标预告</td><td>湖北孝感</td><td>2025/09/30</td></tr>`;
const ROW_NEW = `<tr><td><a class="firstTdAAA" href="/inviteBid/detail/20250930_999999999.html">某新单位采购意向</a></td><td>招标预告</td><td>湖北武汉</td><td>2025/09/30</td></tr>`;

function pageHtml(rows) {
  return `<table id="treeTable"><tbody>${rows.join('')}</tbody></table>`;
}

module.exports = {
  ROW_KNOWN,
  ROW_NEW,
  KNOWN_ID: '20250930_542694266',
  NEW_ID: '20250930_999999999',
  pageHtml
};
