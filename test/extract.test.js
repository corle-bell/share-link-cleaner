import { extractUrl } from '../extract.js';

const cases = [
  {
    name: '抖音分享文案（带无关尾缀）',
    text: '7.92 复制打开抖音，看看【xxx的作品】https://v.douyin.com/abcXYZ/ Z@m.Fd 02/18',
    expected: 'https://v.douyin.com/abcXYZ/'
  },
  {
    name: '淘宝短链（保留 tk 查询参数）',
    text: '【淘宝】https://m.tb.cn/h.xxx?tk=yyy CZ0001 「商品名」点击链接直接打开',
    expected: 'https://m.tb.cn/h.xxx?tk=yyy'
  },
  {
    name: '小红书分享文案',
    text: '45 杨杨发布了一篇小红书笔记，快来看吧！ 😆 http://xhslink.com/a/AbCdEfGh 复制本条信息，打开【小红书】App查看精彩内容！',
    expected: 'http://xhslink.com/a/AbCdEfGh'
  },
  {
    name: 'B站短链',
    text: '【视频标题】 https://b23.tv/xxxxxx 来自哔哩哔哩',
    expected: 'https://b23.tv/xxxxxx'
  },
  {
    name: '知乎链接（去掉粘住的中文标点）',
    text: '这个问题我在知乎看到的 https://www.zhihu.com/question/123456789？点击查看',
    expected: 'https://www.zhihu.com/question/123456789'
  },
  {
    name: '微博链接',
    text: '分享微博 https://weibo.com/1234567890/xxxxxxx 来自@某人',
    expected: 'https://weibo.com/1234567890/xxxxxxx'
  },
  {
    name: '拼多多商品链接',
    text: '拼多多 百亿补贴 https://mobile.yangkeduo.com/goods.html?goods_id=123456 「商品」',
    expected: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456'
  },
  {
    name: '京东短链（去掉结尾中文括号）',
    text: '【京东】https://u.jd.com/abcXYZ」点击立即购买',
    expected: 'https://u.jd.com/abcXYZ'
  },
  {
    name: '无协议的裸域名短链，自动补上 https://',
    text: '复制打开抖音 v.douyin.com/iAbcDef/ 看看这个视频',
    expected: 'https://v.douyin.com/iAbcDef/'
  },
  {
    name: '句号粘在链接末尾',
    text: '好看的视频https://www.bilibili.com/video/BV1xx411c7mD。',
    expected: 'https://www.bilibili.com/video/BV1xx411c7mD'
  },
  {
    name: '多个链接时取第一个',
    text: '先看这个 https://www.zhihu.com/question/1 还有 https://www.zhihu.com/question/2',
    expected: 'https://www.zhihu.com/question/1'
  },
  {
    name: '没有链接时返回 null',
    text: '今天天气真好，一起出去玩吧 Z@m.Fd 02/18',
    expected: null
  },
  {
    name: '百分号编码的链接',
    text: 'https%3A%2F%2Fv.douyin.com%2Fabc%2F',
    expected: 'https://v.douyin.com/abc/'
  },
  {
    name: '分享文案中夹着编码后的链接',
    text: '复制打开抖音 https%3A%2F%2Fv.douyin.com%2FabcXYZ%2F 看看',
    expected: 'https://v.douyin.com/abcXYZ/'
  },
  {
    name: '双重百分号编码',
    text: 'https%253A%252F%252Fv.douyin.com%252Fabc%252F',
    expected: 'https://v.douyin.com/abc/'
  },
  {
    name: '整段分享文案被百分号编码',
    text: encodeURIComponent('7.92 复制打开抖音，看看【xxx的作品】https://v.douyin.com/abcXYZ/ Z@m.Fd 02/18'),
    expected: 'https://v.douyin.com/abcXYZ/'
  },
  {
    name: '普通链接的查询参数编码应保留',
    text: '【淘宝】https://m.tb.cn/h.xxx?tk=yyy%2Fzzz&redirect=https%3A%2F%2Fitem.taobao.com%2Fitem.htm 商品名',
    expected: 'https://m.tb.cn/h.xxx?tk=yyy%2Fzzz&redirect=https%3A%2F%2Fitem.taobao.com%2Fitem.htm'
  },
  {
    name: 'HTML 实体 &amp; 应解码为 &',
    text: '【淘宝】https://m.tb.cn/h.xxx?tk=yyy&amp;id=123 CZ0001',
    expected: 'https://m.tb.cn/h.xxx?tk=yyy&id=123'
  },
  {
    name: '夹杂无效百分号序列时仍能解码有效部分',
    text: 'hello %ZZ world https%3A%2F%2Fb23.tv%2Fxxxx 来看看',
    expected: 'https://b23.tv/xxxx'
  }
];

let failed = 0;
for (const item of cases) {
  const actual = extractUrl(item.text);
  const ok = actual === item.expected;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${item.name}`);
  if (!ok) {
    failed += 1;
    console.log(`      expected: ${item.expected}`);
    console.log(`      actual:   ${actual}`);
  }
}

console.log('');
console.log(`${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
