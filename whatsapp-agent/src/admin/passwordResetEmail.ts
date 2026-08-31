import { config } from "../config";

export function passwordResetEmailConfigured():boolean{
  return Boolean(config.admin.passwordReset.resendApiKey&&config.admin.passwordReset.fromEmail&&config.admin.passwordReset.baseUrl);
}

export async function sendAdministratorPasswordReset(email:string,token:string):Promise<void>{
  if(!passwordResetEmailConfigured())throw new Error("administrator password-reset email is not configured");
  const resetUrl=`${config.admin.passwordReset.baseUrl}/admin/reset-password?token=${encodeURIComponent(token)}`;
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${config.admin.passwordReset.resendApiKey}`,"Content-Type":"application/json"},body:JSON.stringify({from:config.admin.passwordReset.fromEmail,to:[email],subject:"Reset your LuxFi administrator password",text:`A password reset was requested for your LuxFi administrator account. This link expires in 30 minutes and can be used once:\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`})});
  if(!response.ok)throw new Error(`password-reset email provider returned HTTP ${response.status}`);
}
