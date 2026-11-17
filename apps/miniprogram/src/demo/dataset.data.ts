/**
 * 离线演示数据集（自动生成，请勿手改）。
 *
 * 重新生成：
 *   node infra/scripts/export-miniprogram-demo-data.mjs
 *
 * ⚠️ 为什么是 .ts 而不是 .json：
 *   微信小程序运行时对 `require('*.json')` 的支持不确定，
 *   编译期内联成对象字面量 → 运行时零风险。
 *
 * 隐私红线：本文件不含任何联系方式字段（导出脚本已剥离）。
 */
export const RAW_DATASET = {
  "__note": "离线演示数据集：由线上 API 导出（真实公开内容），通讯录为虚构条目，由 src/demo 生成。",
  "__exportedAt": "2026-11-17T12:02:48.455Z",
  "events": [
    {
      "id": 20,
      "title": "调试校友沙龙",
      "kind": "行业沙龙",
      "regionCode": null,
      "regionName": null,
      "place": "呼和浩特",
      "description": null,
      "startsAt": "2026-12-25T02:00:00.000Z",
      "endsAt": "2026-12-25T09:00:00.000Z",
      "capacity": 30,
      "registeredCount": 0,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-16T10:10:51.451Z"
    },
    {
      "id": 4,
      "title": "【虚构】赤峰公益助学活动",
      "kind": "charity",
      "regionCode": "CFS",
      "regionName": "赤峰市",
      "place": "赤峰市某中学",
      "description": "【虚构测试活动】公益助学，规模 30 人。 批次 7206。",
      "startsAt": "2026-03-21T02:00:00.000Z",
      "endsAt": null,
      "capacity": 30,
      "registeredCount": 4,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-15T20:25:47.090Z"
    },
    {
      "id": 3,
      "title": "【虚构】鄂尔多斯校友企业家沙龙",
      "kind": "industry",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "place": "鄂尔多斯市某酒店会议室",
      "description": "【虚构测试活动】企业家沙龙，不限名额。 批次 4933。",
      "startsAt": "2026-03-06T02:00:00.000Z",
      "endsAt": null,
      "capacity": 0,
      "registeredCount": 5,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-15T20:25:47.090Z"
    },
    {
      "id": 2,
      "title": "【虚构】包头新能源产业专场对接会",
      "kind": "industry",
      "regionCode": "BTS",
      "regionName": "包头市",
      "place": "包头市某国际会议中心",
      "description": "【虚构测试活动】面向能源产业校友的对接会。 批次 9007。",
      "startsAt": "2026-02-19T02:00:00.000Z",
      "endsAt": "2026-02-19T05:00:00.000Z",
      "capacity": 50,
      "registeredCount": 4,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-15T20:25:47.090Z"
    },
    {
      "id": 1,
      "title": "【虚构】呼和浩特校友返校日",
      "kind": "reunion",
      "regionCode": "HHS",
      "regionName": "呼和浩特市",
      "place": "呼和浩特市赛罕区某会议中心",
      "description": "【虚构测试活动】校友返校与交流活动，限 5 人，用于验证报名并发控制。 批次 3399。",
      "startsAt": "2026-02-04T02:00:00.000Z",
      "endsAt": "2026-02-04T06:00:00.000Z",
      "capacity": 5,
      "registeredCount": 3,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-15T20:25:47.090Z"
    },
    {
      "id": 21,
      "title": "FK修复验证活动",
      "kind": "行业沙龙",
      "regionCode": null,
      "regionName": null,
      "place": null,
      "description": null,
      "startsAt": null,
      "endsAt": null,
      "capacity": 30,
      "registeredCount": 0,
      "status": "published",
      "coverMediaId": null,
      "myRegistration": null,
      "createdAt": "2026-11-16T10:32:57.203Z"
    }
  ],
  "articles": [
    {
      "id": 8,
      "categoryId": 1,
      "categoryName": "校友动态",
      "title": "【虚构】校友会资讯第 8 期",
      "summary": "【虚构测试数据】第 8 期资讯摘要。",
      "body": "【虚构测试数据】这是第 8 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-08T08:00:00.000Z",
      "viewCount": 161,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-17T05:31:09.000Z"
    },
    {
      "id": 7,
      "categoryId": 4,
      "categoryName": "活动纪实",
      "title": "【虚构】校友会资讯第 7 期",
      "summary": "【虚构测试数据】第 7 期资讯摘要。",
      "body": "【虚构测试数据】这是第 7 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-07T08:00:00.000Z",
      "viewCount": 91,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 6,
      "categoryId": 3,
      "categoryName": "行业观察",
      "title": "【虚构】校友会资讯第 6 期",
      "summary": "【虚构测试数据】第 6 期资讯摘要。",
      "body": "【虚构测试数据】这是第 6 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-06T08:00:00.000Z",
      "viewCount": 78,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 5,
      "categoryId": 2,
      "categoryName": "政策解读",
      "title": "【虚构】校友会资讯第 5 期",
      "summary": "【虚构测试数据】第 5 期资讯摘要。",
      "body": "【虚构测试数据】这是第 5 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-05T08:00:00.000Z",
      "viewCount": 65,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 4,
      "categoryId": 1,
      "categoryName": "校友动态",
      "title": "【虚构】校友会资讯第 4 期",
      "summary": "【虚构测试数据】第 4 期资讯摘要。",
      "body": "【虚构测试数据】这是第 4 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-04T08:00:00.000Z",
      "viewCount": 52,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 3,
      "categoryId": 4,
      "categoryName": "活动纪实",
      "title": "【虚构】校友会资讯第 3 期",
      "summary": "【虚构测试数据】第 3 期资讯摘要。",
      "body": "【虚构测试数据】这是第 3 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-03T08:00:00.000Z",
      "viewCount": 39,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 2,
      "categoryId": 3,
      "categoryName": "行业观察",
      "title": "【虚构】校友会资讯第 2 期",
      "summary": "【虚构测试数据】第 2 期资讯摘要。",
      "body": "【虚构测试数据】这是第 2 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-02T08:00:00.000Z",
      "viewCount": 26,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    },
    {
      "id": 1,
      "categoryId": 2,
      "categoryName": "政策解读",
      "title": "【虚构】校友会资讯第 1 期",
      "summary": "【虚构测试数据】第 1 期资讯摘要。",
      "body": "【虚构测试数据】这是第 1 期资讯正文，用于首页与资讯列表联调。",
      "coverMediaId": null,
      "status": "published",
      "publishedAt": "2026-01-01T08:00:00.000Z",
      "viewCount": 13,
      "createdAt": "2026-11-15T20:04:56.137Z",
      "updatedAt": "2026-11-15T20:04:56.137Z"
    }
  ],
  "articleCategories": [
    {
      "id": 1,
      "name": "校友动态",
      "slug": "alumni-news",
      "sortOrder": 1,
      "articleCount": 2
    },
    {
      "id": 2,
      "name": "政策解读",
      "slug": "policy",
      "sortOrder": 2,
      "articleCount": 2
    },
    {
      "id": 3,
      "name": "行业观察",
      "slug": "industry",
      "sortOrder": 3,
      "articleCount": 2
    },
    {
      "id": 4,
      "name": "活动纪实",
      "slug": "events",
      "sortOrder": 4,
      "articleCount": 2
    }
  ],
  "notices": [
    {
      "id": 4,
      "title": "【虚构】校友会公告第 4 号",
      "body": "【虚构测试数据】第 4 号公告正文。",
      "status": "published",
      "publishedAt": "2026-01-04T09:00:00.000Z",
      "viewCount": 85,
      "createdAt": "2026-11-15T20:04:56.140Z",
      "updatedAt": "2026-11-17T05:31:09.000Z"
    },
    {
      "id": 3,
      "title": "【虚构】校友会公告第 3 号",
      "body": "【虚构测试数据】第 3 号公告正文。",
      "status": "published",
      "publishedAt": "2026-01-03T09:00:00.000Z",
      "viewCount": 21,
      "createdAt": "2026-11-15T20:04:56.140Z",
      "updatedAt": "2026-11-15T20:04:56.140Z"
    },
    {
      "id": 2,
      "title": "【虚构】校友会公告第 2 号",
      "body": "【虚构测试数据】第 2 号公告正文。",
      "status": "published",
      "publishedAt": "2026-01-02T09:00:00.000Z",
      "viewCount": 14,
      "createdAt": "2026-11-15T20:04:56.140Z",
      "updatedAt": "2026-11-15T20:04:56.140Z"
    },
    {
      "id": 1,
      "title": "【虚构】校友会公告第 1 号",
      "body": "【虚构测试数据】第 1 号公告正文。",
      "status": "published",
      "publishedAt": "2026-01-01T09:00:00.000Z",
      "viewCount": 9,
      "createdAt": "2026-11-15T20:04:56.140Z",
      "updatedAt": "2026-11-15T20:04:56.140Z"
    }
  ],
  "resources": [
    {
      "id": 32,
      "authorId": 32,
      "authorName": "校友0032",
      "type": "demand",
      "title": "【虚构】新能源装备采购需求 #32",
      "body": "【虚构测试内容】这是第 32 条合作需求，属于数字科技行业，服务区域为包头市。内容仅用于联调与自动化测试。",
      "industryCode": "DIGI",
      "industryName": "数字科技",
      "regionCode": "BTS",
      "regionName": "包头市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 18,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2026-01-04T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 34,
      "authorId": 34,
      "authorName": "校友0034",
      "type": "demand",
      "title": "【虚构】数据治理与算法咨询需求 #34",
      "body": "【虚构测试内容】这是第 34 条合作需求，属于法律金融行业，服务区域为鄂尔多斯市。内容仅用于联调与自动化测试。",
      "industryCode": "LFIN",
      "industryName": "法律金融",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 20,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-12-01T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 6,
      "authorId": 6,
      "authorName": "校友0006",
      "type": "demand",
      "title": "【虚构】企业管理内训资源 #6",
      "body": "【虚构测试内容】这是第 6 条合作需求，属于农牧食品行业，服务区域为区外。内容仅用于联调与自动化测试。",
      "industryCode": "AGFO",
      "industryName": "农牧食品",
      "regionCode": "OUTSIDE",
      "regionName": "区外",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 3,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-11-23T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 37,
      "authorId": 37,
      "authorName": "校友0037",
      "type": "resource",
      "title": "【虚构】数字科技方向的技术顾问资源 #37",
      "body": "【虚构测试内容】这是第 37 条可共享资源，属于法律金融行业，服务区域为阿拉善盟。内容仅用于联调与自动化测试。",
      "industryCode": "LFIN",
      "industryName": "法律金融",
      "regionCode": "ALM",
      "regionName": "阿拉善盟",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 23,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-11-22T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 21,
      "authorId": 21,
      "authorName": "校友0021",
      "type": "resource",
      "title": "【虚构】农牧冷链仓储资源 #21",
      "body": "【虚构测试内容】这是第 21 条可共享资源，属于文化教育行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "CULT",
      "industryName": "文化教育",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 12,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-11-17T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 29,
      "authorId": 29,
      "authorName": "校友0029",
      "type": "resource",
      "title": "【虚构】教育科研联合实验室需求 #29",
      "body": "【虚构测试内容】这是第 29 条可共享资源，属于教育科研行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "EDUR",
      "industryName": "教育科研",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 16,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-11-13T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 19,
      "authorId": 19,
      "authorName": "校友0019",
      "type": "resource",
      "title": "【虚构】文化教育研学合作资源 #19",
      "body": "【虚构测试内容】这是第 19 条可共享资源，属于能源产业行业，服务区域为通辽市。内容仅用于联调与自动化测试。",
      "industryCode": "ENER",
      "industryName": "能源产业",
      "regionCode": "TLS",
      "regionName": "通辽市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 11,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-10-25T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 11,
      "authorId": 11,
      "authorName": "校友0011",
      "type": "resource",
      "title": "【虚构】绿色算力机房资源 #11",
      "body": "【虚构测试内容】这是第 11 条可共享资源，属于法律金融行业，服务区域为鄂尔多斯市。内容仅用于联调与自动化测试。",
      "industryCode": "LFIN",
      "industryName": "法律金融",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 6,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-10-22T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 59,
      "authorId": 59,
      "authorName": "校友0059",
      "type": "resource",
      "title": "【虚构】绿色算力机房资源 #59",
      "body": "【虚构测试内容】这是第 59 条可共享资源，属于教育科研行业，服务区域为鄂尔多斯市。内容仅用于联调与自动化测试。",
      "industryCode": "EDUR",
      "industryName": "教育科研",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 33,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-10-21T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 1,
      "authorId": 1,
      "authorName": "校友0001",
      "type": "resource",
      "title": "【虚构】数字科技方向的技术顾问资源 #1",
      "body": "【虚构测试内容】这是第 1 条可共享资源，属于能源产业行业，服务区域为巴彦淖尔市。内容仅用于联调与自动化测试。",
      "industryCode": "ENER",
      "industryName": "能源产业",
      "regionCode": "BYNLS",
      "regionName": "巴彦淖尔市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 1,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-10-06T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-15T20:25:47.063Z"
    },
    {
      "id": 16,
      "authorId": 16,
      "authorName": "校友0016",
      "type": "demand",
      "title": "【虚构】法律金融合规咨询服务 #16",
      "body": "【虚构测试内容】这是第 16 条合作需求，属于教育科研行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "EDUR",
      "industryName": "教育科研",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 8,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-09-24T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 10,
      "authorId": 10,
      "authorName": "校友0010",
      "type": "demand",
      "title": "【虚构】数据治理与算法咨询需求 #10",
      "body": "【虚构测试内容】这是第 10 条合作需求，属于法律金融行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "LFIN",
      "industryName": "法律金融",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 5,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-09-07T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 33,
      "authorId": 33,
      "authorName": "校友0033",
      "type": "resource",
      "title": "【虚构】农牧冷链仓储资源 #33",
      "body": "【虚构测试内容】这是第 33 条可共享资源，属于能源产业行业，服务区域为兴安盟。内容仅用于联调与自动化测试。",
      "industryCode": "ENER",
      "industryName": "能源产业",
      "regionCode": "XAM",
      "regionName": "兴安盟",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 19,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-09-02T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 39,
      "authorId": 39,
      "authorName": "校友0039",
      "type": "resource",
      "title": "【虚构】农牧食品渠道合作资源 #39",
      "body": "【虚构测试内容】这是第 39 条可共享资源，属于农牧食品行业，服务区域为兴安盟。内容仅用于联调与自动化测试。",
      "industryCode": "AGFO",
      "industryName": "农牧食品",
      "regionCode": "XAM",
      "regionName": "兴安盟",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 24,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-08-25T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 57,
      "authorId": 57,
      "authorName": "校友0057",
      "type": "resource",
      "title": "【虚构】农牧冷链仓储资源 #57",
      "body": "【虚构测试内容】这是第 57 条可共享资源，属于文化教育行业，服务区域为鄂尔多斯市。内容仅用于联调与自动化测试。",
      "industryCode": "CULT",
      "industryName": "文化教育",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 32,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-08-09T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 23,
      "authorId": 23,
      "authorName": "校友0023",
      "type": "resource",
      "title": "【虚构】绿色算力机房资源 #23",
      "body": "【虚构测试内容】这是第 23 条可共享资源，属于能源产业行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "ENER",
      "industryName": "能源产业",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 13,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-07-30T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 50,
      "authorId": 50,
      "authorName": "校友0050",
      "type": "demand",
      "title": "【虚构】能源产业产能对接需求 #50",
      "body": "【虚构测试内容】这是第 50 条合作需求，属于能源产业行业，服务区域为乌海市。内容仅用于联调与自动化测试。",
      "industryCode": "ENER",
      "industryName": "能源产业",
      "regionCode": "WHS",
      "regionName": "乌海市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 30,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-07-26T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 35,
      "authorId": 35,
      "authorName": "校友0035",
      "type": "resource",
      "title": "【虚构】绿色算力机房资源 #35",
      "body": "【虚构测试内容】这是第 35 条可共享资源，属于农牧食品行业，服务区域为鄂尔多斯市。内容仅用于联调与自动化测试。",
      "industryCode": "AGFO",
      "industryName": "农牧食品",
      "regionCode": "ORDS",
      "regionName": "鄂尔多斯市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 21,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-07-19T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    },
    {
      "id": 5,
      "authorId": 5,
      "authorName": "校友0005",
      "type": "resource",
      "title": "【虚构】教育科研联合实验室需求 #5",
      "body": "【虚构测试内容】这是第 5 条可共享资源，属于企业管理行业，服务区域为巴彦淖尔市。内容仅用于联调与自动化测试。",
      "industryCode": "BIZM",
      "industryName": "企业管理",
      "regionCode": "BYNLS",
      "regionName": "巴彦淖尔市",
      "status": "published",
      "version": 1,
      "attachments": [],
      "reviews": [
        {
          "id": 2,
          "adminId": 1,
          "adminName": "超级管理员",
          "action": "approve",
          "note": "【虚构测试数据】初始审核记录。",
          "snapshotVersion": 1,
          "createdAt": "2026-11-15T20:25:47.081Z"
        }
      ],
      "publishedAt": "2025-07-10T02:00:00.000Z",
      "createdAt": "2026-11-15T20:25:47.063Z",
      "updatedAt": "2026-11-16T10:32:01.144Z"
    }
  ],
  "regions": [
    {
      "code": "HHS",
      "name": "呼和浩特市",
      "level": "city",
      "sortOrder": 1,
      "alumniCount": 25
    },
    {
      "code": "BTS",
      "name": "包头市",
      "level": "city",
      "sortOrder": 2,
      "alumniCount": 33
    },
    {
      "code": "ORDS",
      "name": "鄂尔多斯市",
      "level": "city",
      "sortOrder": 3,
      "alumniCount": 30
    },
    {
      "code": "CFS",
      "name": "赤峰市",
      "level": "city",
      "sortOrder": 4,
      "alumniCount": 38
    },
    {
      "code": "TLS",
      "name": "通辽市",
      "level": "city",
      "sortOrder": 5,
      "alumniCount": 28
    },
    {
      "code": "HLLS",
      "name": "呼伦贝尔市",
      "level": "city",
      "sortOrder": 6,
      "alumniCount": 30
    },
    {
      "code": "BYNLS",
      "name": "巴彦淖尔市",
      "level": "city",
      "sortOrder": 7,
      "alumniCount": 33
    },
    {
      "code": "WLCS",
      "name": "乌兰察布市",
      "level": "city",
      "sortOrder": 8,
      "alumniCount": 25
    },
    {
      "code": "XAM",
      "name": "兴安盟",
      "level": "city",
      "sortOrder": 9,
      "alumniCount": 28
    },
    {
      "code": "XLGLM",
      "name": "锡林郭勒盟",
      "level": "city",
      "sortOrder": 10,
      "alumniCount": 32
    },
    {
      "code": "ALM",
      "name": "阿拉善盟",
      "level": "city",
      "sortOrder": 11,
      "alumniCount": 29
    },
    {
      "code": "WHS",
      "name": "乌海市",
      "level": "city",
      "sortOrder": 12,
      "alumniCount": 31
    },
    {
      "code": "OUTSIDE",
      "name": "区外",
      "level": "outside",
      "sortOrder": 99,
      "alumniCount": 38
    }
  ],
  "industries": [
    {
      "code": "DIGI",
      "name": "数字科技",
      "sortOrder": 1,
      "alumniCount": 52
    },
    {
      "code": "ENER",
      "name": "能源产业",
      "sortOrder": 2,
      "alumniCount": 54
    },
    {
      "code": "AGFO",
      "name": "农牧食品",
      "sortOrder": 3,
      "alumniCount": 54
    },
    {
      "code": "LFIN",
      "name": "法律金融",
      "sortOrder": 4,
      "alumniCount": 61
    },
    {
      "code": "EDUR",
      "name": "教育科研",
      "sortOrder": 5,
      "alumniCount": 64
    },
    {
      "code": "BIZM",
      "name": "企业管理",
      "sortOrder": 6,
      "alumniCount": 64
    },
    {
      "code": "CULT",
      "name": "文化教育",
      "sortOrder": 7,
      "alumniCount": 51
    }
  ],
  "me": {
    "user": {
      "id": 44870,
      "openid": "mock_smoke-tester",
      "nickname": "体验账号",
      "avatarUrl": null,
      "role": null,
      "status": "active",
      "stage": "logged_in",
      "createdAt": "2026-11-16T09:18:09.619Z",
      "lastLoginAt": "2026-11-17T12:02:10.992Z"
    },
    "alumniProfile": {
      "userId": 44870,
      "displayName": "冒烟校友",
      "college": null,
      "degree": null,
      "graduationYear": null,
      "regionCode": null,
      "regionName": null,
      "industryCode": null,
      "industryName": null,
      "direction": null,
      "intro": null,
      "verified": false,
      "verifiedAt": null,
      "contactVisible": true,
      "privacy": {
        "showInDirectory": false,
        "showCollege": true,
        "showIndustry": true,
        "showRegion": true,
        "showDirection": true,
        "acceptContactRequests": true,
        "allowContactShare": true
      },
      "createdAt": "2026-11-16T09:18:09.624Z",
      "updatedAt": "2026-11-16T09:18:09.624Z"
    },
    "stage": "logged_in"
  }
};
