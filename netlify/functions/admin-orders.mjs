import { timingSafeEqual, createHash } from "node:crypto";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff"
};
function reply(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers});
}
function equal(a,b) {
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length>0 && x.length===y.length && timingSafeEqual(x,y);
}
async function stripeGet(path, key) {
  const response=await fetch("https://api.stripe.com"+path,{
    headers:{"Authorization":"Bearer "+key,"Accept":"application/json"}
  });
  if(!response.ok) throw new Error("Stripe API returned "+response.status);
  return response.json();
}
function addressText(address) {
  if(!address) return "";
  return [address.line1,address.line2,
    [address.city,address.state,address.postal_code].filter(Boolean).join(", "),
    address.country==="US"?"":address.country].filter(Boolean).join("\n");
}
export default async function handler(req) {
  if(req.method!=="GET") return reply({error:"Method not allowed"},405);
  const passwordHash="3775b27eec93bfde790c2c14f171e16a1643490c1a40caccd47744e594d14197";
  const suppliedHash=createHash("sha256").update(req.headers.get("x-skinsessed-order-access")||"").digest("hex");
  if(!equal(suppliedHash,passwordHash))
    return reply({error:"Incorrect access code"},401);
  const key=Netlify.env.get("STRIPE_SECRET_KEY");
  if(!key) return reply({error:"Stripe connection unavailable"},503);
  try {
    const qp=new URL(req.url).searchParams;
    const cursor=qp.get("cursor")||"";
    if(cursor && !/^cs_[A-Za-z0-9_]{10,180}$/.test(cursor))
      return reply({error:"Invalid page cursor"},400);
    const p=new URLSearchParams({limit:"20",status:"complete"});
    if(cursor) p.set("starting_after",cursor);
    const page=await stripeGet("/v1/checkout/sessions?"+p.toString(),key);
    const paid=(page.data||[]).filter(s=>s.payment_status==="paid");
    const orders=await Promise.all(paid.map(async s=>{
      let lines=[];
      try {
        const result=await stripeGet("/v1/checkout/sessions/"+encodeURIComponent(s.id)+"/line_items?limit=100",key);
        lines=(result.data||[]).map((l,i)=>({
          name:l.description||"Product",
          quantity:l.quantity||1,
          total:l.amount_total||0,
          note:s.metadata?.["item_"+(i+1)]||""
        }));
      } catch(e) { lines=[{name:"Could not load items",quantity:0,total:0,note:"Reload to retry"}]; }
      const ship=s.collected_information?.shipping_details||s.shipping_details||null;
      const details=s.customer_details||{};
      return {
        id:s.id, created:s.created, total:s.amount_total||0,
        email:details.email||s.customer_email||"",
        name:ship?.name||details.name||"Customer",
        shippingAddress:addressText(ship?.address||details.address),
        paymentIntent:s.payment_intent||"",
        items:lines,
        selections:(s.custom_fields||[]).map(f=>({
          label:f.label?.custom||f.key||"Option",
          value:f.text?.value||f.dropdown?.value||f.numeric?.value||""
        })).filter(x=>x.value)
      };
    }));
    return reply({
      orders,
      hasMore:Boolean(page.has_more),
      nextCursor:page.has_more && page.data?.length ? page.data[page.data.length-1].id:null
    });
  } catch(e) {
    console.error("Orders dashboard error",e?.message);
    return reply({error:"Unable to load Stripe orders. Please try again."},502);
  }
}
