import { PublicWllmReader, HBEU_TEMPLATE } from '../packages/adapters/wllm91/src/public-reader.js';
const reader=new PublicWllmReader();
const page=await reader.read(process.argv[2]??HBEU_TEMPLATE.sample_url);
console.log(JSON.stringify({source_url:page.source_url,observed_at:page.observed_at,kind:page.kind,capability:page.capability,notice:page.notice,jobs:page.jobs.map(j=>({id:j.external_job_id,title:j.title,salary_raw:j.salary_raw,published_date:j.published_date,status:j.status})),links:page.links,warnings:page.warnings},null,2));
